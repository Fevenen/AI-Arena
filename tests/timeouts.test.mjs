import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMockOpenAI } from './helpers/mock-openai.mjs';
import {
  testModelConnection,
  requestModelCompletion,
} from '../packages/models/index.mjs';
import { DafeiyuClient } from '../apps/server/dafeiyu-client.mjs';

function configFor(mock, timeoutMs = 2000) {
  return {
    name: 'timeout test',
    provider: 'openai-compatible',
    baseUrl: mock.baseUrl,
    modelId: mock.model,
    apiKey: mock.apiKey ?? '',
    timeoutMs,
    maxRetries: 0,
  };
}

async function createHeaderThenBodyServer({ delayMs = 800 } = {}) {
  const server = http.createServer((req, res) => {
    for (const _ of []) void _;
    req.resume();
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      const payload = JSON.stringify({
        ok: true,
        sessionId: 'late-session',
        personaName: '大肥鱼',
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.flushHeaders?.();
      setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) res.end(payload);
      }, delayMs);
    }, 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

test('普通模型：收到响应头后正文卡住仍会超时，而不是无限等待', async () => {
  const mock = await createMockOpenAI({ apiKey: 'local', bodyDelayMs: 1200 });
  try {
    const started = Date.now();
    const result = await testModelConnection(configFor(mock, 220));
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'timeout');
    assert.match(result.error.message, /未完成响应|超时/);
    assert.ok(elapsed < 1200, `应在正文延迟结束前超时，实际 ${elapsed}ms`);
  } finally {
    await mock.close();
  }
});

test('普通模型：正文读取阶段主动取消会立即取消请求', async () => {
  const mock = await createMockOpenAI({ apiKey: 'local', bodyDelayMs: 1500 });
  const controller = new AbortController();
  try {
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      () => requestModelCompletion(configFor(mock, 5000), {
        messages: [{ role: 'user', content: '测试' }],
        signal: controller.signal,
      }),
      (error) => error.code === 'cancelled',
    );
    assert.ok(Date.now() - started < 1000);
  } finally {
    await mock.close();
  }
});

test('大肥鱼客户端：收到响应头后正文卡住会超时', async () => {
  const server = await createHeaderThenBodyServer({ delayMs: 900 });
  try {
    const client = new DafeiyuClient({
      bridgeUrl: server.url,
      apiBase: '/api/game/arena',
      timeoutMs: 180,
    });
    const started = Date.now();
    await assert.rejects(
      () => client.connect({ matchId: 'match-timeout' }),
      (error) => error.code === 'timeout',
    );
    assert.ok(Date.now() - started < 900);
  } finally {
    await server.close();
  }
});

test('大肥鱼客户端：正文读取阶段主动取消会取消请求', async () => {
  const server = await createHeaderThenBodyServer({ delayMs: 1500 });
  const controller = new AbortController();
  try {
    const client = new DafeiyuClient({
      bridgeUrl: server.url,
      apiBase: '/api/game/arena',
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      () => client.comment({
        sessionId: 's',
        matchId: 'm',
        role: 'observer',
        snapshot: {},
        event: {},
        signal: controller.signal,
      }),
      (error) => error.code === 'cancelled',
    );
  } finally {
    await server.close();
  }
});
