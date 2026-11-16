import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { createMockOpenAI } from './helpers/mock-openai.mjs';
import { gomokuGame } from '../packages/games/gomoku/index.mjs';
import { threeSeatGame } from './fixtures/three-seat-game.mjs';
import { MatchService } from '../apps/server/match-service.mjs';
import { MatchStore } from '../apps/server/match-store.mjs';

const games = [gomokuGame, threeSeatGame];

function modelInput(name, mock) {
  return {
    name,
    provider: 'openai-compatible',
    baseUrl: mock.baseUrl,
    modelId: mock.model,
    apiKey: mock.apiKey ?? '',
    timeoutMs: 5000,
    maxRetries: 1,
  };
}

function threeBotSeats() {
  return {
    sun: { kind: 'bot' },
    moon: { kind: 'bot' },
    star: { kind: 'bot' },
  };
}

test('三座位插件出现在游戏注册表，逐座位行动并完成结算', async () => {
  const harness = await createServiceHarness({ gamePlugins: games });
  try {
    assert.deepEqual(harness.service.games.map((game) => game.id), ['gomoku', 'three-seat-test']);
    const created = await harness.service.createMatch({
      gameId: 'three-seat-test',
      seats: threeBotSeats(),
      dafeiyu: { enabled: false },
    });
    assert.deepEqual(created.seatOrder, ['sun', 'moon', 'star']);
    assert.equal(created.gameName, '三席测试局');
    assert.equal(created.modeLabel.includes('全 AI'), true);
    await waitFor(() => harness.service.getMatch(created.id).status === 'finished', {
      timeoutMs: 8000,
      message: '三座位对局未结束',
    });
    const finished = harness.service.getMatch(created.id);
    assert.ok(finished.actionCount >= 8 && finished.actionCount <= 9);
    const expectedSeats = Array.from(
      { length: finished.actions.length },
      (_, index) => ['sun', 'moon', 'star'][index % 3],
    ).join(',');
    assert.equal(finished.actions.map((action) => action.seat).join(','), expectedSeats);
    assert.ok(['win', 'draw'].includes(finished.resultGroup));
    assert.ok(finished.state.outcome);
    assert.equal(finished.actions[0].action.cell, 1);
    assert.ok(finished.actions.every((action) => action.source === 'bot'));
  } finally {
    await harness.cleanup();
  }
});

test('私有目标不会出现在公开对局、SSE 快照或导出中', async () => {
  const harness = await createServiceHarness({ gamePlugins: games });
  try {
    const created = await harness.service.createMatch({
      gameId: 'three-seat-test',
      seats: threeBotSeats(),
      dafeiyu: { enabled: false },
    });
    const publicJson = JSON.stringify(harness.service.getMatch(created.id));
    assert.doesNotMatch(publicJson, /SUN-SECRET|MOON-SECRET|STAR-SECRET|privateTargets|secretNote/);
    assert.doesNotMatch(publicJson, /"target":/);
    await waitFor(() => harness.service.getMatch(created.id).status === 'finished', {
      timeoutMs: 8000,
      message: '三座位对局未结束',
    });
    const exported = JSON.stringify(harness.service.exportMatch(created.id));
    assert.doesNotMatch(exported, /SUN-SECRET|MOON-SECRET|STAR-SECRET|privateTargets|secretNote/);
    const replay = harness.service.getReplay(created.id);
    assert.equal(replay.steps.length, replay.actionCount + 1);
    assert.ok(['win', 'draw'].includes(replay.steps.at(-1).view.outcome.type));
    assert.doesNotMatch(JSON.stringify(replay), /privateTargets|secretNote|SUN-SECRET/);
    // 插件自己的座位视图仍然可见私有目标，证明过滤发生在平台出口而非把数据删掉。
    const raw = threeSeatGame.createInitialState({ seed: 'view' });
    const sunView = threeSeatGame.getSeatView(raw, 'sun');
    assert.equal(sunView.target, 1);
    assert.match(sunView.secretNote, /SUN-SECRET/);
  } finally {
    await harness.cleanup();
  }
});

test('模型提示带自己的座位和私有信息，规则辅助候选只给当前回合', async () => {
  const mock = await createMockOpenAI({ responder: () => '{"cell":1,"say":"我先占自己的目标格。"}' });
  const harness = await createServiceHarness({
    gamePlugins: games,
    models: [modelInput('三席模型', mock)],
  });
  try {
    const model = harness.configStore.listModels()[0];
    const created = await harness.service.createMatch({
      gameId: 'three-seat-test',
      seats: {
        sun: { kind: 'model', modelId: model.id, moveMode: 'assisted' },
        moon: { kind: 'bot' },
        star: { kind: 'bot' },
      },
      dafeiyu: { enabled: false },
    });
    await waitFor(() => harness.service.getMatch(created.id).actionCount >= 1, {
      timeoutMs: 5000,
      message: '三席模型没有落子',
    });
    assert.equal(mock.requests.length >= 1, true);
    const prompt = mock.requests[0].body.messages.map((message) => message.content).join('\n');
    assert.match(prompt, /sun|金席/);
    assert.match(prompt, /SUN-SECRET/);
    assert.doesNotMatch(prompt, /MOON-SECRET|STAR-SECRET/);
    assert.match(prompt, /规则辅助模式/);
    const after = harness.service.getMatch(created.id);
    assert.equal(after.actions[0].seat, 'sun');
    assert.equal(after.actions[0].action.cell, 1);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('三席测试局的私有目标参与结算，且公开视图仍不泄露目标', () => {
  let state = threeSeatGame.createInitialState({ seed: 'private-target' });
  const actions = [
    ['sun', 6], ['moon', 2], ['star', 1],
    ['sun', 8], ['moon', 5], ['star', 3],
    ['sun', 9], ['moon', 7], ['star', 4],
  ];
  for (let index = 0; index < actions.length; index += 1) {
    const [seat, cell] = actions[index];
    const applied = threeSeatGame.applyAction(state, seat, { cell });
    state = applied.state;
    if (index < actions.length - 1) {
      assert.equal(state.outcome, null);
      assert.doesNotMatch(JSON.stringify(threeSeatGame.getPublicState(state)), /SUN-SECRET|privateTargets|secretNote/);
    }
  }
  assert.equal(state.outcome.type, 'win');
  assert.equal(state.outcome.winnerSeat, 'moon');
  assert.equal(state.outcome.reason, 'private_target');
  assert.equal(state.outcome.cell, 4);
  assert.equal(state.board.flat().filter(Boolean).length, 9);
  assert.equal(threeSeatGame.getSeatView(state, 'moon').target, 5);
  assert.doesNotMatch(JSON.stringify(threeSeatGame.getPublicState(state)), /privateTargets|secretNote|SUN-SECRET|"target":/);
});

test('切换插件规则版本后，旧局仍用权威快照回放', async () => {
  const harness = await createServiceHarness({ gamePlugins: games });
  try {
    const created = await harness.service.createMatch({
      gameId: 'three-seat-test',
      seats: threeBotSeats(),
      dafeiyu: { enabled: false },
    });
    await waitFor(() => harness.service.getMatch(created.id).status === 'finished', {
      timeoutMs: 8000,
      message: '三座位对局未结束',
    });
    const before = harness.service.getReplay(created.id);
    assert.equal(before.steps.length, before.actionCount + 1);
    const bumped = { ...threeSeatGame, rulesVersion: '9.9.9' };
    const store = new MatchStore(harness.configStore.matchDir);
    const other = new MatchService({
      configStore: harness.configStore,
      store,
      hub: harness.hub,
      logger: { info() {}, warn() {}, error() {} },
      gamePlugins: [gomokuGame, bumped],
      originProvider: () => 'http://127.0.0.1:8787',
    });
    const replay = other.getReplay(created.id);
    assert.equal(replay.steps.length, replay.actionCount + 1);
    assert.equal(replay.rulesVersion, '1.0.0');
    assert.ok(['win', 'draw'].includes(replay.steps.at(-1).view.outcome.type));
    await other.close();
  } finally {
    await harness.cleanup();
  }
});
