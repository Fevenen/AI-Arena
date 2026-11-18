// Values describe the provider/model protocol, never synthetic token budgets.
export const REASONING_PROFILES = Object.freeze({
  auto: { label: '自动识别', efforts: ['default'], source: 'unknown' },
  deepseek: { label: 'DeepSeek 原生', efforts: ['default', 'low', 'high', 'max'], source: 'model' },
  qwen: { label: 'Qwen 思考开关', efforts: ['default'], source: 'model' },
  kvmem: { label: 'KVMem 引擎扩展', efforts: ['default', 'low', 'medium', 'high'], source: 'engine' },
});

export function reasoningAdapter(config) {
  if (config.reasoningAdapter && config.reasoningAdapter !== 'auto') return config.reasoningAdapter;
  let host = ''; try { host = new URL(config.baseUrl).hostname; } catch {}
  if (host === 'api.deepseek.com' && (!config.modelId || /^(deepseek-flash|deepseek-v4[^/]*)$/.test(config.modelId))) return 'deepseek';
  if (/qwen(?:3[._-]?5|3[._-]?6|3\.5)/i.test(config.modelId ?? '')) return 'qwen';
  return 'auto';
}

export function describeReasoning(config) {
  const adapter = reasoningAdapter(config);
  const profile = REASONING_PROFILES[adapter] ?? REASONING_PROFILES.auto;
  const oldOff = ['off', 'none'].includes(config.reasoningEffort);
  const thinking = config.thinkingMode ?? (oldOff ? 'off' : 'default');
  const rawEffort = oldOff ? 'default' : config.reasoningEffort ?? 'default';
  const effort = profile.efforts.includes(rawEffort) ? rawEffort : 'default';
  const sent = {};
  if (adapter === 'deepseek') {
    if (thinking !== 'default') sent.thinking = { type: thinking === 'off' ? 'disabled' : 'enabled' };
    if (thinking !== 'off' && effort !== 'default') {
      sent.thinking = { type: 'enabled' };
      sent.reasoning_effort = effort;
    }
  } else if (adapter === 'qwen' || adapter === 'kvmem') {
    if (thinking !== 'default') sent.chat_template_kwargs = { enable_thinking: thinking === 'on' };
    if (adapter === 'kvmem' && thinking !== 'off' && effort !== 'default') sent.reasoning_effort = effort;
  }
  const label = adapter === 'auto' ? '跟随服务（能力未确认）'
    : thinking === 'off' ? '关闭思考'
      : effort !== 'default' ? `${adapter === 'kvmem' ? '引擎 ' : ''}${effort}`
        : thinking === 'on' ? '开启思考' : '跟随服务默认';
  return { adapter, source: profile.source, thinking, effort, sent, label,
    confirmation: Object.keys(sent).length ? 'requested' : 'inherited',
    legacyIgnoredEffort: rawEffort !== effort ? rawEffort : null };
}

export function validateReasoning(input) {
  const adapter = input.reasoningAdapter ?? 'auto';
  if (!REASONING_PROFILES[adapter]) return '未知的推理协议。';
  if (!['default', 'on', 'off'].includes(input.thinkingMode ?? 'default')) return '思考开关必须是 default / on / off。';
  const profile = REASONING_PROFILES[reasoningAdapter(input)];
  const effort = input.reasoningEffort ?? 'default';
  // Old records remain readable. Explicitly selected adapters validate their native values.
  if (adapter !== 'auto' && ![...profile.efforts, 'off', 'none'].includes(effort)) return `此协议支持的推理强度：${profile.efforts.join(' / ')}。`;
  return null;
}
