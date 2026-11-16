import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { createMockDafeiyu } from './helpers/mock-dafeiyu.mjs';

async function pausedAfterMove({ mockOptions = {}, dafeiyuSettings = {} } = {}) {
  const mock = await createMockDafeiyu(mockOptions);
  const harness = await createServiceHarness({
    dafeiyuUrl: mock.url,
    dafeiyuSettings,
    matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0, autoCommentCooldownMs: 0 },
  });
  const created = await harness.service.createMatch({
    gameId: 'gomoku',
    seats: { black: { kind: 'human' }, white: { kind: 'dafeiyu', moveMode: 'assisted' } },
    dafeiyu: { enabled: true, autoComment: false, voice: false },
  });
  harness.subscribe(created.id);
  await waitFor(() => harness.service.getMatch(created.id).dafeiyu.status === 'connected', {
    timeoutMs: 5000,
    message: '大肥鱼没有连接',
  });
  await harness.service.submitHumanAction(created.id, {
    seat: 'black',
    action: { type: 'place', move: 'H8' },
  });
  await waitFor(() => harness.service.getMatch(created.id).status === 'paused', {
    timeoutMs: 6000,
    message: '落子失败后没有暂停',
  });
  return { harness, mock, id: created.id };
}

test('桥接 429 被标成模型繁忙，不误判掉线；重试可继续', async () => {
  const { harness, mock, id } = await pausedAfterMove({
    mockOptions: {
      moveFailure: { status: 429, code: 'player_busy', message: '大肥鱼正在落子，请稍后再问。' },
    },
  });
  try {
    const paused = harness.service.getMatch(id);
    assert.equal(paused.pause.code, 'dafeiyu_busy');
    assert.equal(paused.dafeiyu.status, 'connected');
    assert.equal(paused.errors.some((error) => error.code === 'dafeiyu_busy'), true);
    assert.equal(paused.errors.some((error) => error.code === 'dafeiyu_disconnected'), false);
    mock.setMoveFailure(null);
    mock.state.moveResponder = () => JSON.stringify({ move: 'H7', say: '让开。' });
    assert.equal(harness.service.retryMatch(id).status, 'playing');
    await waitFor(() => harness.service.getMatch(id).actionCount >= 2, {
      timeoutMs: 5000,
      message: '重试后没有落子',
    });
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('自由文本落子被拒绝，重试耗尽后暂停为输出解析失败', async () => {
  const { harness, mock, id } = await pausedAfterMove({
    mockOptions: { moveResponder: () => '我想下在 H8，但不告诉你怎么写 JSON。' },
  });
  try {
    const paused = harness.service.getMatch(id);
    assert.equal(paused.pause.code, 'dafeiyu_output_invalid');
    assert.equal(paused.dafeiyu.status, 'connected');
    assert.equal(mock.requestsFor('move').length, 2);
    assert.equal(paused.actionCount, 1);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('合法 JSON 但非法落子被标成非法动作，不误判掉线', async () => {
  const { harness, mock, id } = await pausedAfterMove({
    mockOptions: { moveResponder: () => JSON.stringify({ move: 'H8' }) },
  });
  try {
    const paused = harness.service.getMatch(id);
    assert.equal(paused.pause.code, 'dafeiyu_invalid_move');
    assert.equal(paused.dafeiyu.status, 'connected');
    assert.equal(mock.requestsFor('move').length, 2);
    assert.equal(paused.actionCount, 1);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('后台自动点评失败不会把棋手判成掉线，也不会暂停棋局', async () => {
  const mock = await createMockDafeiyu({
    commentFailure: { status: 503, code: 'unreachable', message: 'mock comment transport down' },
  });
  const harness = await createServiceHarness({
    dafeiyuUrl: mock.url,
    matchSettings: { aiMoveDelayMs: 300, initialAiDelayMs: 50, autoCommentCooldownMs: 0 },
  });
  try {
    const created = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: { black: { kind: 'bot' }, white: { kind: 'bot' } },
      dafeiyu: { enabled: true, autoComment: true, voice: false },
    });
    harness.subscribe(created.id);
    await waitFor(() => harness.service.getMatch(created.id).dafeiyu.status === 'connected', {
      timeoutMs: 5000,
      message: '大肥鱼没有连接',
    });
    await waitFor(() => mock.requestsFor('comment').length >= 1, {
      timeoutMs: 6000,
      message: '没有尝试自动点评',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const match = harness.service.getMatch(created.id);
    assert.equal(match.dafeiyu.status, 'connected');
    assert.notEqual(match.status, 'paused');
    assert.equal(match.pause, null);
    assert.equal(match.errors.some((error) => error.source === 'dafeiyu_comment'), true);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('正文超时标成超时，连接仍保留', async () => {
  const { harness, mock, id } = await pausedAfterMove({
    mockOptions: { moveDelayMs: 900 },
    dafeiyuSettings: { timeoutMs: 200 },
  });
  try {
    const paused = harness.service.getMatch(id);
    assert.equal(paused.pause.code, 'dafeiyu_timeout');
    assert.equal(paused.dafeiyu.status, 'connected');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});
