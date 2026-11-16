import { ModelError, redactSecret, shorten } from './errors.mjs';

function safeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new ModelError('config', 'Base URL 不能为空。', { stage: 'config' });
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ModelError('invalid_url', 'Base URL 不是合法的 http(s) 地址。', { stage: 'config' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ModelError('invalid_url', 'Base URL 只支持 http:// 或 https://。', { stage: 'config' });
  }
  if (!url.hostname) {
    throw new ModelError('invalid_url', 'Base URL 缺少主机名。', { stage: 'config' });
  }
  url.hash = '';
  url.search = '';
  return url;
}

export function normalizeBaseUrl(value) {
  const url = safeBaseUrl(value);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path || '/';
  return url.toString().replace(/\/$/, '');
}

/**
 * 兼容两种常见填法：
 *   http://host:18200/v1     -> http://host:18200/v1/chat/completions
 *   http://host:18200        -> http://host:18200/v1/chat/completions
 * 已填完整 endpoint 时保持原样，便于接少数自定义网关。
 */
export function resolveChatEndpoint(baseUrl) {
  const url = safeBaseUrl(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    // 保持原路径。
  } else if (/\/v\d+$/.test(path)) {
    path = `${path}/chat/completions`;
  } else if (path === '' || path === '/') {
    path = '/v1/chat/completions';
  } else {
    path = `${path}/v1/chat/completions`;
  }
  url.pathname = path;
  return url.toString();
}

export function buildHeaders(config) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const key = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function extractContent(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

function errorFromResponse(response, bodyText, config) {
  const body = redactSecret(shorten(bodyText, 800), config.apiKey);
  let code = 'request_rejected';
  let message = `模型请求失败（HTTP ${response.status}）。`;
  let stage = 'model';
  let retryable = false;

  let apiError = null;
  try {
    apiError = JSON.parse(bodyText);
  } catch {
    // 非 JSON 错误体只保留脱敏摘要。
  }
  const apiMessage = apiError?.error?.message || apiError?.message || '';
  const apiCode = apiError?.error?.code || apiError?.code || '';

  if (response.status === 401 || response.status === 403) {
    code = 'auth';
    message = '认证失败：API Key 无效、缺失或没有访问该模型的权限。';
    stage = 'auth';
  } else if (response.status === 404) {
    const haystack = `${apiMessage} ${apiCode}`.toLowerCase();
    if (haystack.includes('model') || haystack.includes('模型')) {
      code = 'model_not_found';
      message = '模型不存在：请检查 Model ID 是否与供应商一致。';
      stage = 'model';
    } else {
      code = 'endpoint_not_found';
      message = '接口路径不存在（HTTP 404）：请检查 Base URL 是否包含正确的 /v1 或自定义路径。';
      stage = 'network';
    }
  } else if (response.status === 429) {
    code = 'rate_limited';
    message = '请求频率受限（HTTP 429），请稍后重试。';
    retryable = true;
  } else if (response.status >= 500) {
    code = 'server_error';
    message = `模型服务返回 HTTP ${response.status}，请检查本地服务或稍后重试。`;
    retryable = true;
  } else {
    code = 'request_rejected';
    message = `模型请求被拒绝（HTTP ${response.status}）。`;
  }

  const detailParts = [];
  if (apiMessage) detailParts.push(redactSecret(shorten(apiMessage, 300), config.apiKey));
  if (body && !apiMessage) detailParts.push(body);
  return new ModelError(code, message, {
    status: response.status,
    stage,
    retryable,
    detail: detailParts.join(' '),
  });
}

function networkError(error, config) {
  const causeCode = error?.cause?.code || error?.code || '';
  const detail = redactSecret(shorten(error?.cause?.message || error?.message || '', 300), config.apiKey);
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return new ModelError('unreachable', '地址不可达：无法解析主机名。', {
      stage: 'network',
      retryable: true,
      detail,
    });
  }
  if (causeCode === 'ECONNREFUSED') {
    return new ModelError('unreachable', '地址不可达：连接被拒绝，服务可能没有启动或端口不正确。', {
      stage: 'network',
      retryable: true,
      detail,
    });
  }
  if (causeCode === 'ECONNRESET' || causeCode === 'EPIPE') {
    return new ModelError('unreachable', '连接被服务端中断，请检查本地服务状态。', {
      stage: 'network',
      retryable: true,
      detail,
    });
  }
  return new ModelError('unreachable', '地址不可达或网络请求失败。', {
    stage: 'network',
    retryable: true,
    detail: detail || causeCode,
  });
}

async function createCompletion(config, { messages, temperature = 0.2, maxTokens = 512, signal } = {}) {
  const endpoint = resolveChatEndpoint(config.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 120000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new ModelError('timeout', `连接超时：模型在 ${Math.round(timeoutMs / 1000)} 秒内没有返回。`, {
        stage: 'network',
        retryable: true,
        detail: redactSecret(error.message, config.apiKey),
      });
    }
    if (cancelled) {
      throw new ModelError('cancelled', '请求已取消。', { stage: 'network', retryable: false });
    }
    throw networkError(error, config);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const bodyText = await response.text();
  if (!response.ok) throw errorFromResponse(response, bodyText, config);
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new ModelError('invalid_response', '模型返回的不是 JSON。', {
      stage: 'response',
      detail: redactSecret(shorten(bodyText, 300), config.apiKey),
    });
  }
  const content = extractContent(data);
  if (typeof content !== 'string') {
    throw new ModelError('invalid_response', '模型返回缺少 choices[0].message.content。', {
      stage: 'response',
      detail: redactSecret(shorten(bodyText, 300), config.apiKey),
    });
  }
  return {
    text: content,
    raw: data,
    endpoint,
    usage: data.usage ?? null,
  };
}

async function testConnection(config, { signal } = {}) {
  // 先用极小请求验证地址、鉴权和模型；不依赖部分本地服务不支持的 GET /models。
  const started = Date.now();
  try {
    const result = await createCompletion(config, {
      messages: [
        { role: 'system', content: '这是一个连接测试。' },
        { role: 'user', content: '只回复 OK。' },
      ],
      temperature: 0,
      maxTokens: 8,
      signal,
    });
    return {
      ok: true,
      durationMs: Date.now() - started,
      endpoint: result.endpoint,
      checks: [
        { name: '配置', ok: true, detail: '字段格式正确。' },
        { name: '地址', ok: true, detail: '已收到模型 HTTP 响应。' },
        { name: '认证与模型', ok: true, detail: '模型已返回内容。' },
      ],
    };
  } catch (error) {
    const modelError = error instanceof ModelError
      ? error
      : new ModelError('unreachable', '连接测试失败。', { stage: 'network' });
    let checks;
    if (modelError.stage === 'config') {
      checks = [
        { name: '配置', ok: false, detail: modelError.message },
        { name: '地址', ok: null, detail: '配置未通过，未发起请求。' },
        { name: '认证与模型', ok: null, detail: '配置未通过，未发起请求。' },
      ];
    } else if (modelError.stage === 'network') {
      checks = [
        { name: '配置', ok: true, detail: '字段格式正确。' },
        { name: '地址', ok: false, detail: modelError.message },
        { name: '认证与模型', ok: null, detail: '尚未收到模型响应，未能验证。' },
      ];
    } else {
      checks = [
        { name: '配置', ok: true, detail: '字段格式正确。' },
        { name: '地址', ok: true, detail: '已收到模型 HTTP 响应。' },
        { name: '认证与模型', ok: false, detail: modelError.message },
      ];
    }
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: modelError.toPublic(),
      checks,
    };
  }
}

export const openAICompatibleProvider = {
  id: 'openai-compatible',
  label: 'OpenAI 兼容接口',
  description: '支持 OpenAI Chat Completions 协议的云端供应商与本地模型服务。',
  defaultBaseUrl: 'http://127.0.0.1:18200/v1',
  defaultModelId: 'kvmem-polystrata-qwen35',
  fields: [
    { key: 'baseUrl', label: 'Base URL', required: true },
    { key: 'modelId', label: 'Model ID', required: true },
    { key: 'apiKey', label: 'API Key', secret: true, required: false },
    { key: 'timeoutMs', label: '超时（毫秒）', required: true },
  ],
  normalizeBaseUrl,
  resolveChatEndpoint,
  buildHeaders,
  createCompletion,
  testConnection,
};
