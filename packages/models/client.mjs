import { describeReasoning, validateReasoning } from './reasoning.mjs';
import { getProvider } from './provider-registry.mjs';
import { ModelError } from './errors.mjs';

export const REASONING_EFFORTS = Object.freeze(['default', 'off', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_MAX_OUTPUT_TOKENS = 4800;
export const MAX_OUTPUT_TOKENS_LIMIT = 131072;

export function providerFor(config) {
  const provider = getProvider(config?.provider);
  if (!provider) {
    throw new ModelError('config', `未知的接口类型：${config?.provider ?? '(空)'}`, { stage: 'config' });
  }
  return provider;
}

export function validateModelConfig(input, { requireKey = false } = {}) {
  const errors = [];
  const name = String(input?.name ?? '').trim();
  const baseUrl = String(input?.baseUrl ?? '').trim();
  const modelId = String(input?.modelId ?? '').trim();
  const provider = String(input?.provider ?? 'openai-compatible').trim();
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey : '';
  const timeoutMs = Number(input?.timeoutMs ?? 120000);
  const maxRetries = Number(input?.maxRetries ?? 2);
  const reasoningEffortRaw = String(input?.reasoningEffort ?? 'default').trim().toLowerCase();
  const reasoningEffort = REASONING_EFFORTS.includes(reasoningEffortRaw) ? reasoningEffortRaw : '';
  const reasoningError = validateReasoning(input ?? {});
  if (reasoningError) errors.push(reasoningError);
  const maxOutputTokens = Number(input?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);

  if (!name) errors.push('显示名称不能为空。');
  if (name.length > 80) errors.push('显示名称不能超过 80 字。');
  if (!getProvider(provider)) errors.push(`不支持或尚未注册的接口类型：${provider || '(空)'}`);
  if (!baseUrl) errors.push('Base URL 不能为空。');
  if (!modelId) errors.push('Model ID 不能为空。');
  if (modelId.length > 200) errors.push('Model ID 不能超过 200 字。');
  if (requireKey && !apiKey) errors.push('该操作需要 API Key。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    errors.push('超时必须是 1000 到 600000 之间的毫秒数。');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    errors.push('重试次数必须是 0 到 5 的整数。');
  }
  if (!reasoningEffort) {
    errors.push(`推理强度必须是：${REASONING_EFFORTS.join(' / ')}。`);
  }
  if (!Number.isInteger(maxOutputTokens)
    || maxOutputTokens < 256 || maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT) {
    errors.push(`单步输出上限必须是 256 到 ${MAX_OUTPUT_TOKENS_LIMIT} 的整数。`);
  }
  try {
    getProvider(provider)?.normalizeBaseUrl(baseUrl);
  } catch (error) {
    errors.push(error.message);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      provider,
      baseUrl,
      modelId,
      apiKey,
      timeoutMs,
      maxRetries,
      reasoningEffort,
      reasoningAdapter: input.reasoningAdapter ?? 'auto',
      thinkingMode: input.thinkingMode ?? (reasoningEffort === 'off' ? 'off' : 'default'),
      maxOutputTokens,
    },
  };
}

export async function testModelConnection(config, options = {}) {
  const provider = providerFor(config);
  return provider.testConnection(config, options);
}

export async function requestModelCompletion(config, options = {}) {
  const provider = providerFor(config);
  const { monitor, monitorContext = {}, ...requestOptions } = options;
  const reasoning = describeReasoning(config);
  const span = monitor?.start({ ...monitorContext, modelId: config.modelId, modelName: config.name,
    modelConfigId: config.id, reasoning, maxTokens: options.maxTokens });
  try {
    const result = await provider.createCompletion(config, { ...requestOptions, taskType:monitorContext.pace==='fast'?'timed_move':monitorContext.task ?? 'move',
      onProgress: (stage, data) => { span?.update(stage, data); requestOptions.onProgress?.(stage, data); } });
    const u = result.usage;
    const usage = u ? { prompt_tokens:u.prompt_tokens, completion_tokens:u.completion_tokens,
      total_tokens:u.total_tokens, completion_tokens_details:{reasoning_tokens:u.completion_tokens_details?.reasoning_tokens ?? null},
      prompt_cache_hit_tokens:u.prompt_cache_hit_tokens ?? null } : null;
    span?.finish(result.finishReason === 'length' ? 'truncated' : 'completed', { usage,
      finishReason: result.finishReason, timing:result.timing ?? null });
    return { ...result, monitorId:span?.id ?? null, reasoning };
  } catch(error) {
    span?.finish(error.code === 'cancelled' ? 'cancelled' : 'failed', { errorCode:error.code ?? 'model_error' });
    throw error;
  }
}

export function describeModelEndpoint(config) {
  const provider = providerFor(config);
  return provider.resolveChatEndpoint(config.baseUrl);
}
