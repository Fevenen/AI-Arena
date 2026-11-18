import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMockOpenAI } from './helpers/mock-openai.mjs';
import { createMockDafeiyu } from './helpers/mock-dafeiyu.mjs';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { ConfigStore } from '../apps/server/config-store.mjs';
import { MatchStore } from '../apps/server/match-store.mjs';
import { EventHub } from '../apps/server/event-hub.mjs';
import { MatchService } from '../apps/server/match-service.mjs';

function modelInput(name, mock, { apiKey = '', retries = 0, maxOutputTokens = 4800, reasoningEffort = 'default' } = {}) {
  return {
    name,
    provider: 'openai-compatible',
    baseUrl: mock.baseUrl,
    modelId: mock.model,
    apiKey,
    timeoutMs: 5000,
    maxRetries: retries,
    maxOutputTokens,
    reasoningEffort,
  };
}

function jsonMove(move, say = '') {
  return JSON.stringify({ move, ...(say ? { say } : {}) });
}

test('真人对模型：点击落子后模型经统一校验落子，座位和来源被记录', async () => {
  const mock = await createMockOpenAI({ responder: () => jsonMove('A1', '我走左上。') });
  const harness = await createServiceHarness({ models: [modelInput('模拟白方', mock)] });
  try {
    const model = harness.configStore.listModels()[0];
    const initial = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'model', modelId: model.id },
      },
      dafeiyu: { enabled: false },
    });
    assert.equal(initial.seats.black.kind, 'human');
    assert.match(initial.seats.white.engineLabel, /普通模型/);
    const submitted = await harness.service.submitHumanAction(initial.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
      clientActionId: 'client-1',
    });
    assert.equal(submitted.accepted, true);
    await waitFor(() => {
      const match = harness.service.getMatch(initial.id);
      return match.actionCount === 2 && match.state.turn === 'black';
    }, { message: '模型没有完成落子' });
    const match = harness.service.getMatch(initial.id);
    assert.equal(match.actions[0].source, 'human');
    assert.equal(match.actions[1].source, 'model');
    assert.equal(match.actions[1].action.move, 'A1');
    assert.equal(match.actions[1].modelMeta.reasoningEffort, 'default');
    assert.equal(match.actions[1].modelMeta.maxTokens, 4800);
    assert.equal(match.actions[1].modelMeta.tokenUsage.completionTokens, 5);
    assert.equal(match.actions[1].modelMeta.tokenUsage.totalTokens, 15);
    assert.equal(match.state.board[7][7], 'black');
    assert.equal(match.state.board[14][0], 'white');
    assert.equal(match.chat.length, 0);
    assert.doesNotMatch(JSON.stringify(mock.requests[0].body.messages), /公开想法|\bsay\b/);
    assert.equal(mock.requests.length, 1);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('重复提交同一 clientActionId 不重复落子；完成后迟到操作被拒绝', async () => {
  const mock = await createMockOpenAI({ responder: () => jsonMove('A1') });
  const harness = await createServiceHarness({
    models: [modelInput('白方', mock)],
    matchSettings: { aiMoveDelayMs: 5000 },
  });
  try {
    const model = harness.configStore.listModels()[0];
    const initial = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'model', modelId: model.id },
      },
    });
    const first = await harness.service.submitHumanAction(initial.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
      clientActionId: 'same-id',
    });
    const duplicate = await harness.service.submitHumanAction(initial.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
      clientActionId: 'same-id',
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(harness.service.getMatch(initial.id).actionCount, 1);
    await assert.rejects(
      () => harness.service.submitHumanAction(initial.id, {
        seat: 'white',
        action: { type: 'place', move: 'A2' },
      }),
      /不是真人|轮到/,
    );
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('两个独立模型配置互打，完整终局，模型 Key 只用于各自请求', async () => {
  const blackMock = await createMockOpenAI({ apiKey: 'black-key' });
  const whiteMock = await createMockOpenAI({ apiKey: 'white-key' });
  const blackMoves = ['A1', 'B1', 'C1', 'D1', 'E1'];
  const whiteMoves = ['A15', 'C15', 'E15', 'G15'];
  let blackIndex = 0;
  let whiteIndex = 0;
  blackMock.setResponder(() => jsonMove(blackMoves[blackIndex++]));
  whiteMock.setResponder(() => jsonMove(whiteMoves[whiteIndex++]));
  const harness = await createServiceHarness({
    models: [
      modelInput('黑方模型', blackMock, { apiKey: 'black-key' }),
      modelInput('白方模型', whiteMock, { apiKey: 'white-key' }),
    ],
  });
  try {
    const models = harness.configStore.listModels();
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'model', modelId: models[0].id },
        white: { kind: 'model', modelId: models[1].id },
      },
      dafeiyu: { enabled: false },
    });
    await waitFor(() => harness.service.getMatch(match.id).status === 'finished', {
      timeoutMs: 30000,
      message: '双模型对局未结束',
    });
    const finished = harness.service.getMatch(match.id);
    assert.equal(finished.result, 'win');
    assert.equal(finished.resultGroup, 'win');
    assert.equal(finished.winnerSeat, 'black');
    assert.equal(finished.actionCount, 9);
    assert.equal(finished.actions.filter((item) => item.source === 'model').length, 9);
    assert.equal(blackMock.requests.length, 5);
    assert.equal(whiteMock.requests.length, 4);
    assert.ok(blackMock.requests.every((request) => request.headers.authorization === 'Bearer black-key'));
    assert.ok(whiteMock.requests.every((request) => request.headers.authorization === 'Bearer white-key'));
    const replay = harness.service.getReplay(match.id);
    assert.equal(replay.steps.length, 10);
    assert.equal(replay.steps.at(-1).view.outcome.winnerSeat, 'black');
    const exported = JSON.stringify(harness.service.exportMatch(match.id));
    assert.doesNotMatch(exported, /black-key|white-key/);
    assert.equal(exported.includes('模拟') || exported.includes('黑方模型'), true);
  } finally {
    await harness.cleanup();
    await blackMock.close();
    await whiteMock.close();
  }
});

test('模型非法落子有限重试后暂停，不再静默替换为机器人', async () => {
  const mock = await createMockOpenAI({ responder: () => '我不会下棋' });
  const harness = await createServiceHarness({
    models: [modelInput('坏棋模型', mock, { retries: 1 })],
  });
  try {
    const model = harness.configStore.listModels()[0];
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'model', modelId: model.id },
      },
    });
    await harness.service.submitHumanAction(match.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
    });
    await waitFor(() => harness.service.getMatch(match.id).status === 'paused', {
      timeoutMs: 5000,
      message: '非法落子后没有暂停',
    });
    const paused = harness.service.getMatch(match.id);
    assert.equal(paused.pause.code, 'ai_invalid_move');
    assert.equal(paused.actionCount, 1);
    assert.equal(mock.requests.length, 2);
    assert.equal(paused.errors.length >= 1, true);
    assert.equal(mock.requests.every((request) => request.body.max_tokens === 4800), true);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('输出达到上限时增加落子预算，收到完整 JSON 后继续棋局', async () => {
  const mock = await createMockOpenAI({
    responder: (request) => request.body.max_tokens < 32768
      ? { content: '', finishReason: 'length' }
      : jsonMove('A1', '普通模型的发言应被忽略'),
  });
  const harness = await createServiceHarness({
    models: [modelInput('思考模型', mock, { retries: 2, maxOutputTokens: 32768 })],
  });
  try {
    const [model] = harness.configStore.listModels();
    const { id } = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'human' }, white: { kind: 'model', modelId: model.id } },
    });
    await harness.service.submitHumanAction(id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
    });
    const match = await waitFor(() => {
      const snapshot = harness.service.getMatch(id);
      return snapshot.actionCount === 2 ? snapshot : null;
    });
    assert.deepEqual(mock.requests.map(({ body }) => body.max_tokens), [16384, 32768]);
    assert.equal(match.status, 'playing');
    assert.equal(match.actions[1].action.move, 'A1');
    assert.equal(match.actions[1].metrics.failures[0].code, 'model_output_truncated');
    assert.equal(match.chat.length, 0);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('暂停后迟到的模型回复不能落子；继续后重新请求才推进', async () => {
  const mock = await createMockOpenAI({
    delayMs: 500,
    responder: () => jsonMove('A1'),
  });
  const harness = await createServiceHarness({
    models: [modelInput('慢模型', mock)],
    matchSettings: { aiMoveDelayMs: 20 },
  });
  try {
    const model = harness.configStore.listModels()[0];
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'model', modelId: model.id },
      },
    });
    await harness.service.submitHumanAction(match.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
    });
    await waitFor(() => harness.service.getMatch(match.id).pending != null, { message: '没有进入 AI 等待' });
    harness.service.pauseMatch(match.id);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const paused = harness.service.getMatch(match.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.actionCount, 1);
    assert.equal(paused.state.board[14][0], null);
    harness.service.resumeMatch(match.id);
    await waitFor(() => harness.service.getMatch(match.id).actionCount === 2, {
      timeoutMs: 5000,
      message: '继续后模型没有落子',
    });
    assert.equal(harness.service.getMatch(match.id).state.board[14][0], 'white');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('全 AI 对局可暂停、单步推进、保持暂停、继续', async () => {
  const harness = await createServiceHarness({
    matchSettings: { initialAiDelayMs: 5000, aiMoveDelayMs: 5000 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'bot' },
        white: { kind: 'bot' },
      },
    });
    harness.service.pauseMatch(match.id);
    assert.equal(harness.service.getMatch(match.id).status, 'paused');
    const step1 = await harness.service.stepMatch(match.id);
    assert.equal(step1.actionCount, 1);
    assert.equal(step1.status, 'paused');
    assert.equal(step1.pause.code, 'step_done');
    assert.equal(step1.state.turn, 'white');
    const step2 = await harness.service.stepMatch(match.id);
    assert.equal(step2.actionCount, 2);
    assert.equal(step2.status, 'paused');
    assert.equal(step2.state.turn, 'black');
    harness.service.resumeMatch(match.id);
    assert.equal(harness.service.getMatch(match.id).status, 'playing');
    harness.service.endMatch(match.id, { reason: '测试结束' });
    assert.equal(harness.service.getMatch(match.id).status, 'aborted');
  } finally {
    await harness.cleanup();
  }
});

test('重启后已完成对局仍可打开回放，活动对局标记为中止', async () => {
  const harness = await createServiceHarness({
    matchSettings: { initialAiDelayMs: 0, aiMoveDelayMs: 0 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'bot' }, white: { kind: 'bot' } },
    });
    await waitFor(() => harness.service.getMatch(match.id).status === 'finished', {
      timeoutMs: 12000,
      message: '机器人对局没有结束',
    });
    const before = harness.service.getReplay(match.id);
    assert.ok(before.totalSteps > 5);
    await harness.cleanup({ keepDir: true });

    const configStore = new ConfigStore({ configPath: harness.configPath });
    const store = new MatchStore(configStore.matchDir);
    const hub = new EventHub({ heartbeatMs: 60000 });
    const service = new MatchService({
      configStore,
      store,
      hub,
      logger: { info() {}, warn() {}, error() {} },
      originProvider: () => 'http://127.0.0.1:8787',
    });
    try {
      const replay = service.getReplay(match.id);
      assert.equal(replay.totalSteps, before.totalSteps);
      assert.ok(replay.steps.at(-1).view.outcome);
      const listed = service.listMatches({ status: 'finished' });
      assert.equal(listed.length, 1);
    } finally {
      await service.close();
      hub.close();
      fs.rmSync(harness.dir, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(harness.dir, { recursive: true, force: true });
    throw error;
  }
});

test('大肥鱼观战：手动提问、自动点评、语音开关、事件去重和点评冷却', async () => {
  const pet = await createMockDafeiyu({ commentDelayMs: 0 });
  const harness = await createServiceHarness({
    dafeiyuUrl: pet.url,
    matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0, autoCommentCooldownMs: 2000 },
    dafeiyuSettings: { healthIntervalMs: 5000 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'bot' }, white: { kind: 'bot' } },
      dafeiyu: { enabled: true, autoComment: true, voice: false },
    });
    harness.subscribe(match.id);
    await waitFor(() => harness.service.getMatch(match.id).dafeiyu.status === 'connected', {
      message: '大肥鱼没有连接',
    });
    await waitFor(() => harness.service.getMatch(match.id).status === 'finished', {
      timeoutMs: 30000,
      message: '观战对局没有结束',
    });
    await waitFor(() => harness.service.getMatch(match.id).chat.some((chat) => chat.kind === 'comment'), {
      message: '没有自动点评',
    });
    const beforeAsk = harness.service.getMatch(match.id);
    const comments = beforeAsk.chat.filter((chat) => chat.kind === 'comment');
    assert.ok(comments.length >= 1);
    const commentKeys = pet.requestsFor('comment').map((request) => request.body.event.key);
    assert.equal(new Set(commentKeys).size, commentKeys.length, '相同事件被重复请求');
    assert.equal(pet.requestsFor('speak').length, 0, '语音关闭时不应调用播报');

    const updated = await harness.service.askDafeiyu(match.id, { text: '黑棋现在有什么威胁？' });
    assert.equal(updated.chat.filter((chat) => chat.kind === 'question').length, 1);
    assert.equal(updated.chat.filter((chat) => chat.kind === 'answer').length, 1);
    assert.equal(pet.requestsFor('speak').length, 0);

    await harness.service.patchDafeiyu(match.id, { voice: true });
    await harness.service.askDafeiyu(match.id, { text: '再说一句。' });
    await waitFor(() => pet.requestsFor('speak').length >= 1, { message: '语音开启后没有调用播报' });
    assert.equal(harness.service.getMatch(match.id).chat.filter((chat) => chat.kind === 'answer').at(-1).voiceStatus, 'queued');

    const speakCount = pet.requestsFor('speak').length;
    await harness.service.patchDafeiyu(match.id, { voice: false });
    await harness.service.askDafeiyu(match.id, { text: '关了语音也看得见字吧？' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pet.requestsFor('speak').length, speakCount);
    harness.unsubscribe(match.id);
  } finally {
    await harness.cleanup();
    await pet.close();
  }
});

test('大肥鱼棋手完整落子；掉线暂停；重连后继续', async () => {
  const pet = await createMockDafeiyu();
  const harness = await createServiceHarness({
    dafeiyuUrl: pet.url,
    matchSettings: { initialAiDelayMs: 10000, aiMoveDelayMs: 0, autoCommentCooldownMs: 0 },
    dafeiyuSettings: { healthIntervalMs: 60000 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'dafeiyu' },
        white: { kind: 'bot' },
      },
      dafeiyu: { enabled: true, autoComment: false, voice: false },
    });
    await waitFor(() => harness.service.getMatch(match.id).dafeiyu.status === 'connected', {
      message: '棋手大肥鱼没有连接',
    });
    await harness.service.disconnectDafeiyu(match.id);
    const disconnected = harness.service.getMatch(match.id);
    assert.equal(disconnected.status, 'paused');
    assert.equal(disconnected.pause.code, 'dafeiyu_disconnected');
    assert.equal(disconnected.dafeiyu.status, 'disconnected');
    pet.setOnline(false);
    await assert.rejects(() => harness.service.reconnectDafeiyu(match.id), /不可达|连接|大肥鱼/);
    pet.setOnline(true);
    await harness.service.reconnectDafeiyu(match.id);
    assert.equal(harness.service.getMatch(match.id).dafeiyu.status, 'connected');
    harness.service.resumeMatch(match.id);
    // 初始 AI 延迟较长，直接单步推进验证真落子（全 AI 对局）。
    harness.service.pauseMatch(match.id);
    const stepped = await harness.service.stepMatch(match.id);
    assert.ok(stepped.actions.some((action) => action.source === 'dafeiyu'));
    assert.ok(harness.service.getMatch(match.id).chat.some((chat) => chat.role === 'dafeiyu' && chat.kind === 'thought'));
    assert.ok(pet.requestsFor('move').length >= 1);
    harness.service.endMatch(match.id, { reason: '测试完成' });
  } finally {
    await harness.cleanup();
    await pet.close();
  }
});

test('大肥鱼观战掉线时棋局继续；关闭点评/语音可独立控制', async () => {
  const pet = await createMockDafeiyu();
  const harness = await createServiceHarness({
    dafeiyuUrl: pet.url,
    matchSettings: { initialAiDelayMs: 10000, aiMoveDelayMs: 10000 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'human' }, white: { kind: 'bot' } },
      dafeiyu: { enabled: true, autoComment: true, voice: true },
    });
    await waitFor(() => harness.service.getMatch(match.id).dafeiyu.status === 'connected', {
      message: '观察者没有连接',
    });
    await harness.service.disconnectDafeiyu(match.id);
    const afterDisconnect = harness.service.getMatch(match.id);
    assert.equal(afterDisconnect.status, 'playing');
    assert.equal(afterDisconnect.dafeiyu.status, 'disconnected');
    await harness.service.patchDafeiyu(match.id, { autoComment: false, voice: false });
    assert.equal(harness.service.getMatch(match.id).dafeiyu.autoComment, false);
    assert.equal(harness.service.getMatch(match.id).dafeiyu.voice, false);
  } finally {
    await harness.cleanup();
    await pet.close();
  }
});

test('没有观众时不再产生迟到自动点评；取消订阅会丢弃进行中的点评', async () => {
  const pet = await createMockDafeiyu({ commentDelayMs: 500 });
  const harness = await createServiceHarness({
    dafeiyuUrl: pet.url,
    matchSettings: { initialAiDelayMs: 0, aiMoveDelayMs: 0, autoCommentCooldownMs: 0 },
    dafeiyuSettings: { healthIntervalMs: 60000 },
  });
  try {
    const match = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'bot' }, white: { kind: 'bot' } },
      dafeiyu: { enabled: true, autoComment: true, voice: true },
    });
    harness.subscribe(match.id);
    await waitFor(() => harness.service.getMatch(match.id).dafeiyu.status === 'connected', {
      message: '观察者没有连接',
    });
    await waitFor(() => pet.requestsFor('comment').length > 0, {
      timeoutMs: 10000,
      message: '没有自动点评请求',
    });
    harness.unsubscribe(match.id);
    await waitFor(() => harness.service.getMatch(match.id).status === 'finished', {
      timeoutMs: 30000,
      message: '对局没有结束',
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const final = harness.service.getMatch(match.id);
    assert.equal(
      final.chat.filter((chat) => chat.kind === 'comment').length,
      0,
      '离开后迟到的自动点评仍然写入',
    );
    assert.equal(pet.requestsFor('speak').length, 0, '离开后不应触发语音');
  } finally {
    await harness.cleanup();
    await pet.close();
  }
});
