import http from 'node:http';

/**
 * 可编程的 OpenAI 兼容服务。测试里可校验路径、鉴权头和模型名，
 * 并通过 responder 返回合法/非法/延迟或错误响应。
 */
export async function createMockOpenAI(options = {}) {
  const {
    model = 'mock-model',
    apiKey = null,
    delayMs = 0,
    responder = null,
    bodyDelayMs = 0,
    modelId = `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  } = options;
  const state = {
    requests: [],
    responder,
    delayMs,
    bodyDelayMs,
    failures: [],
  };
  const pending = new Set();

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Not Found' }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad json' } }));
      return;
    }
    const record = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      model: body.model,
      body,
      at: Date.now(),
    };
    state.requests.push(record);
    const delay = typeof state.delayMs === 'function' ? state.delayMs(record) : state.delayMs;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (res.destroyed) return;

    if (apiKey !== null) {
      const expected = `Bearer ${apiKey}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
        return;
      }
    }
    if (body.model !== model) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `The model '${body.model}' does not exist`, code: 'model_not_found' } }));
      return;
    }
    const forced = state.failures.shift();
    if (forced) {
      res.writeHead(forced.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(forced.body ?? { error: { message: 'forced failure' } }));
      return;
    }
    let content = 'OK';
    if (state.responder) {
      const result = await state.responder(record, state);
      if (result && typeof result === 'object' && result.httpStatus) {
        res.writeHead(result.httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }
      if (typeof result === 'string') content = result;
    }
    const payload = JSON.stringify({
      id: `chatcmpl-${state.requests.length}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    if (state.bodyDelayMs > 0) {
      // 专门模拟：先发响应头，再延迟正文。
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.flushHeaders?.();
      await new Promise((resolve) => setTimeout(resolve, state.bodyDelayMs));
      if (!res.destroyed && !res.writableEnded) res.end(payload);
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    }, 0);
    pending.add(timer);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    id: modelId,
    model,
    baseUrl,
    apiKey,
    url: `http://127.0.0.1:${port}`,
    state,
    setResponder(fn) {
      state.responder = fn;
    },
    setDelay(ms) {
      state.delayMs = ms;
    },
    setBodyDelay(ms) {
      state.bodyDelayMs = ms;
    },
    pushFailure(failure) {
      state.failures.push(failure);
    },
    requests: state.requests,
    async close() {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
