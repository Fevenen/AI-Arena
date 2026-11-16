import { openAICompatibleProvider } from './openai-compatible.mjs';

const providers = new Map();

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.createCompletion !== 'function') {
    throw new TypeError('模型适配器需要 id 和 createCompletion');
  }
  providers.set(provider.id, Object.freeze(provider));
}

export function getProvider(id) {
  return providers.get(id) ?? null;
}

export function listProviders() {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description,
    defaultBaseUrl: provider.defaultBaseUrl ?? '',
    defaultModelId: provider.defaultModelId ?? '',
    fields: provider.fields ?? [],
  }));
}

registerProvider(openAICompatibleProvider);

export const DEFAULT_PROVIDER_ID = 'openai-compatible';
