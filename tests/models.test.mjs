import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBaseUrl,
  resolveChatEndpoint,
  testModelConnection,
  requestModelCompletion,
  validateModelConfig,
} from '../packages/models/index.mjs';
import gomokuGame from '../packages/games/gomoku/index.mjs';
import { createMockOpenAI } from './helpers/mock-openai.mjs';

function modelFor(mock, overrides = {}) {
  return {
    name: '本地测试模型',
    provider: 'openai-compatible',
    baseUrl: mock.baseUrl,
    modelId: mock.model,
    apiKey: mock.apiKey ?? '',
    timeoutMs: 5000,
    maxRetries: 1,
    ...overrides,
  };
}

test('Base URL 兼容已含 /v1、末尾斜杠、无路径和完整 endpoint', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:18200/v1/'), 'http://127.0.0.1:18200/v1');
  assert.equal(resolveChatEndpoint('http://127.0.0.1:18200/v1/'), 'http://127.0.0.1:18200/v1/chat/completions');
  assert.equal(resolveChatEndpoint('http://127.0.0.1:18200'), 'http://127.0.0.1:18200/v1/chat/completions');
  assert.equal(resolveChatEndpoint('http://127.0.0.1:18200/'), 'http://127.0.0.1:18200/v1/chat/completions');
  assert.equal(
    resolveChatEndpoint('http://127.0.0.1:18200/v1/chat/completions'),
    'http://127.0.0.1:18200/v1/chat/completions',
  );
  assert.equal(
    resolveChatEndpoint('https://gateway.example.com/openai/v1/'),
    'https://gateway.example.com/openai/v1/chat/completions',
  );
  assert.throws(() => normalizeBaseUrl('ftp://example.com/v1'), /http/);
  assert.throws(() => normalizeBaseUrl('not a url'), /合法/);
});

test('模型配置字段校验；无 Key 合法', () => {
  const valid = validateModelConfig({
    name: '无 Key 本地服务',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    modelId: 'local-model',
    apiKey: '',
    timeoutMs: 30000,
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.apiKey, '');
  const invalid = validateModelConfig({ name: '', baseUrl: 'nope', modelId: '' });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 3);
});

test('连接测试成功；有 Key 时发送 Bearer local，无 Key 时不发 Authorization', async () => {
  const withKey = await createMockOpenAI({ apiKey: 'local' });
  try {
    const result = await testModelConnection(modelFor(withKey, { apiKey: 'local' }));
    assert.equal(result.ok, true);
    assert.equal(withKey.requests.length, 1);
    assert.equal(withKey.requests[0].headers.authorization, 'Bearer local');
    assert.equal(withKey.requests[0].path, '/v1/chat/completions');
    assert.equal(withKey.requests[0].model, withKey.model);
  } finally {
    await withKey.close();
  }

  const noKey = await createMockOpenAI({ apiKey: null });
  try {
    const result = await testModelConnection(modelFor(noKey));
    assert.equal(result.ok, true);
    assert.equal(noKey.requests[0].headers.authorization, undefined);
  } finally {
    await noKey.close();
  }
});

test('认证失败和模型不存在被明确区分，且错误不泄露 Key', async () => {
  const mock = await createMockOpenAI({ apiKey: 'correct-key' });
  try {
    const auth = await testModelConnection(modelFor(mock, { apiKey: 'wrong-super-secret-key' }));
    assert.equal(auth.ok, false);
    assert.equal(auth.error.code, 'auth');
    assert.equal(auth.error.stage, 'auth');
    assert.match(auth.error.message, /认证失败/);
    assert.doesNotMatch(JSON.stringify(auth), /wrong-super-secret-key/);

    const model = await testModelConnection(modelFor(mock, { apiKey: 'correct-key', modelId: 'missing-model' }));
    assert.equal(model.ok, false);
    assert.equal(model.error.code, 'model_not_found');
    assert.match(model.error.message, /模型不存在/);
    assert.doesNotMatch(JSON.stringify(model), /correct-key/);
  } finally {
    await mock.close();
  }
});

test('地址不可达、超时和 404 接口路径分类', async () => {
  const unreachable = await testModelConnection({
    ...modelFor({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKey: null }),
    timeoutMs: 2000,
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.error.stage, 'network');
  assert.match(unreachable.error.message, /地址不可达/);

  const slow = await createMockOpenAI({ delayMs: 1500 });
  try {
    const timeout = await testModelConnection(modelFor(slow, { timeoutMs: 300 }), {
      // 使用独立的短超时，避免测试等待。
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error.code, 'timeout');
    assert.match(timeout.error.message, /连接超时/);
  } finally {
    await slow.close();
  }

  const badPath = await testModelConnection({
    ...modelFor({ baseUrl: 'http://127.0.0.1:1/v1', model: 'x', apiKey: null }),
    baseUrl: 'http://127.0.0.1:1/api',
  });
  assert.equal(badPath.ok, false);
});

test('模型非法落子的文本可被五子棋插件拒绝，合法 JSON 可解析', async () => {
  const mock = await createMockOpenAI();
  try {
    const response = await requestModelCompletion(modelFor(mock), {
      messages: [{ role: 'user', content: '落子' }],
      maxTokens: 32,
    });
    assert.equal(response.text, 'OK');
    assert.equal(gomokuGame.parseModelMove(response.text).ok, false);
    assert.equal(gomokuGame.parseModelMove('{"move":"H8","say":"占中"}').action.move, 'H8');
  } finally {
    await mock.close();
  }
});

test('内置机器人在空盘占中，并能抓住立即成五机会', () => {
  let state = gomokuGame.createInitialState({ seed: 'bot-test' });
  assert.deepEqual(gomokuGame.chooseBotAction({ state, seat: 'black', seed: 'bot-test' }), {
    type: 'place',
    move: 'H8',
  });
  // 手工摆出黑方四连，白方走一步不干扰；机器人执黑应直接成五。
  const board = state.board.map((row) => row.slice());
  for (let col = 4; col < 8; col += 1) board[7][col] = 'black';
  board[6][6] = 'white';
  state = {
    ...state,
    board,
    turn: 'black',
    moveCount: 5,
  };
  const move = gomokuGame.chooseBotAction({ state, seat: 'black', seed: 'bot-test' });
  assert.ok(move.move === 'I8' || move.move === 'D8');
});
