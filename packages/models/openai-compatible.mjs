import { acquireLocalSlot } from './local-queue.mjs';
import { describeReasoning } from './reasoning.mjs';
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

export function reasoningRequestFields(config, endpoint) {
  return describeReasoning({ ...config, baseUrl: config.baseUrl ?? endpoint }).sent;
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

async function readCompletionStream(response, endpoint, started, headersMs, onProgress) {
  const decoder = new TextDecoder();
  let buffered = '', text = '', finishReason = null, usage = null;
  let firstOutputMs = null, firstActionMs = null, firstAnswerMs = null;
  function accept(line) {
    const payload = line.trim();
    if (!payload.startsWith('data:')) return;
    const value = payload.slice(5).trim();
    if (!value || value === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(value); } catch { return; }
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;
    if (firstOutputMs == null && (content || choice?.delta?.reasoning_content)) firstOutputMs = Math.round(performance.now() - started);
    if (choice?.delta?.reasoning_content) onProgress?.('thinking', { firstOutputMs });
    if (content) {
      firstAnswerMs ??= Math.round(performance.now() - started);
      onProgress?.('answering', { firstOutputMs, firstAnswerMs });
    }
    if (typeof content === 'string') {
      text += content;
      if (firstActionMs == null && text.trim().endsWith('}')) {
        try {
          const result = JSON.parse(text);
          if (result && !Array.isArray(result) && typeof result === 'object') firstActionMs = Math.round(performance.now() - started);
        } catch {}
      }
    }
    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk.usage ?? usage;
  }
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) accept(line);
  }
  accept(buffered + decoder.decode());
  return { text, finishReason, endpoint, usage,
    timing: { headersMs, firstOutputMs, firstAnswerMs, firstActionMs, totalMs: Math.round(performance.now() - started) } };
}

const serviceSnapshots=new Map();
async function serviceDefault(config){
  const url=new URL(config.baseUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['qwen','kvmem'].includes(describeReasoning(config).adapter))return null;
  const cached=serviceSnapshots.get(url.origin);
  if(cached && Date.now()-cached.at<3000)return cached.value;
  let value=null;
  try{const response=await fetch(url.origin+'/props',{signal:AbortSignal.timeout(400)});
    if(response.ok){const data=await response.json();const effective=data.effective_settings?.effective;
      if(effective)value={reasoningEffort:effective.reasoning_effort,reasoningBudgetTokens:effective.reasoning_budget_tokens,
        source:data.effective_settings?.sources?.reasoning_effort??'service',observedAt:new Date().toISOString(),
        templateReadsEffort:typeof data.chat_template==='string'?data.chat_template.includes('reasoning_effort'):null};}
  }catch{}
  serviceSnapshots.set(url.origin,{at:Date.now(),value});return value;
}

async function createCompletion(config, { messages, temperature = 0.2, maxTokens = 512, signal, probe = false, measureStream = false, onProgress = null, taskType = 'move' } = {}) {
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
  let releaseSlot = () => {};
  const started = performance.now();
  try {
    const endpointHost = new URL(endpoint).hostname;
    const reasoningFields = reasoningRequestFields(config, endpoint);
    // Connection tests stay fast and deterministic even when the saved
    // gameplay effort is low/high; actual move requests use the setting above.
    if (probe && endpointHost === 'api.deepseek.com') {
      reasoningFields.thinking = { type: 'disabled' };
      delete reasoningFields.reasoning_effort;
    }
    const defaults=await serviceDefault(config);
    if(defaults)onProgress?.('queued',{serviceDefault:defaults});
    releaseSlot = await acquireLocalSlot(endpoint, { signal:controller.signal, task:probe?'probe':taskType, onProgress });
    onProgress?.('requesting', {});
    response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: measureStream,
        ...(measureStream ? { stream_options: { include_usage: true } } : {}),
        ...reasoningFields,
      }),
      signal: controller.signal,
    });

    const headersMs = Math.round(performance.now() - started);
    onProgress?.('waiting_output', { headersMs });
    // 必须在响应正文完整读取后再撤掉计时器和外部取消监听。
    // 部分服务会先返回响应头、再长时间等待模型生成正文。
    if (response.ok && measureStream && response.headers.get('content-type')?.includes('text/event-stream')) {
      return await readCompletionStream(response, endpoint, started, headersMs, onProgress);
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
      finishReason: data?.choices?.[0]?.finish_reason ?? null,
      raw: data,
      endpoint,
      usage: data.usage ?? null,
      timing: { headersMs, totalMs: Math.round(performance.now() - started) },
    };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (timedOut) {
      throw new ModelError('timeout', `连接超时：模型在 ${Math.round(timeoutMs / 1000)} 秒内未完成响应。`, {
        stage: 'network',
        retryable: true,
        detail: redactSecret(error?.message ?? '', config.apiKey),
      });
    }
    if (cancelled) {
      throw new ModelError('cancelled', '请求已取消。', { stage: 'network', retryable: false });
    }
    throw networkError(error, config);
  } finally {
    releaseSlot();
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
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
      maxTokens: 128,
      signal,
      probe: true,
    });
    const reasoning = result.raw?.choices?.[0]?.message?.reasoning_content;
    const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningOnly = !result.text.trim() && result.finishReason === 'length'
      && ((typeof reasoning === 'string' && reasoning.trim().length > 0) || reasoningTokens > 0);
    if (!result.text.trim() && !reasoningOnly) {
      const message = result.finishReason === 'length'
        ? '模型输出达到上限，连接测试没有收到正文。'
        : '模型接口已响应，但没有返回正文。';
      throw new ModelError('invalid_response', message, { stage: 'response' });
    }
    return {
      ok: true,
      durationMs: Date.now() - started,
      endpoint: result.endpoint,
      ...(reasoningOnly ? { warning: '接口与模型已响应。128 tokens 测试预算在思考阶段用尽，尚未生成最终正文。' } : {}),
      checks: [
        { name: '配置', ok: true, detail: '字段格式正确。' },
        { name: '地址', ok: true, detail: '已收到模型 HTTP 响应。' },
        { name: '认证与模型', ok: true, detail: reasoningOnly ? '已收到模型推理输出，最终正文未完成。' : '模型已返回内容。' },
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
