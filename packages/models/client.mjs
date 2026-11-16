import { getProvider } from './provider-registry.mjs';
import { ModelError } from './errors.mjs';

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
    },
  };
}

export async function testModelConnection(config, options = {}) {
  const provider = providerFor(config);
  return provider.testConnection(config, options);
}

export async function requestModelCompletion(config, options = {}) {
  const provider = providerFor(config);
  return provider.createCompletion(config, options);
}

export function describeModelEndpoint(config) {
  const provider = providerFor(config);
  return provider.resolveChatEndpoint(config.baseUrl);
}
