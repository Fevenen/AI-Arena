export const MODEL_ERROR_LABELS = {
  config: '配置错误',
  invalid_url: '地址格式错误',
  unreachable: '地址不可达',
  timeout: '连接超时',
  auth: '认证失败',
  model_not_found: '模型不存在',
  endpoint_not_found: '接口路径不存在',
  rate_limited: '请求频率受限',
  request_rejected: '模型请求被拒绝',
  server_error: '模型服务错误',
  invalid_response: '返回格式不正确',
  cancelled: '请求已取消',
  unavailable: '模型不可用',
};

export class ModelError extends Error {
  constructor(code, message, { status = null, stage = 'model', retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.retryable = retryable;
    this.detail = detail;
    this.label = MODEL_ERROR_LABELS[code] ?? '模型请求失败';
  }

  toPublic() {
    return {
      code: this.code,
      label: this.label,
      message: this.message,
      status: this.status,
      stage: this.stage,
      retryable: this.retryable,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function redactSecret(value, secret) {
  let text = String(value ?? '');
  if (secret && String(secret).length >= 3) {
    text = text.split(String(secret)).join('[REDACTED]');
  }
  // 常见鉴权头格式也一并遮挡，防止上游回显。
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]');
  return text;
}

export function shorten(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
