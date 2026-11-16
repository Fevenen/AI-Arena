/** 可安全返回给本机前端的业务错误。 */
export class ArenaError extends Error {
  constructor(code, message, { status = 400, details = null, retryable = false } = {}) {
    super(message);
    this.name = 'ArenaError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

export class RuleError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
    this.details = details;
  }
}
