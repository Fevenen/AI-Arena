/**
 * 竞技场 → 大肥鱼桌宠的本机桥接客户端。
 * 只发送当前身份可见的公开局面；不把竞技场 API Key 传给桌宠。
 */
export class DafeiyuError extends Error {
  constructor(code, message, { status = null, retryable = true } = {}) {
    super(message);
    this.name = 'DafeiyuError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  toPublic() {
    return { code: this.code, message: this.message, status: this.status, retryable: this.retryable };
  }
}

function joinUrl(base, apiBase, operation) {
  const root = String(base ?? '').replace(/\/+$/, '');
  const prefix = String(apiBase ?? '/api/game/arena').replace(/\/+$/, '');
  return `${root}${prefix}/${operation}`;
}

export class DafeiyuClient {
  constructor({ bridgeUrl, apiBase = '/api/game/arena', token = '', origin = '', timeoutMs = 90000 }) {
    this.bridgeUrl = String(bridgeUrl ?? '').replace(/\/+$/, '');
    this.apiBase = apiBase || '/api/game/arena';
    this.token = token || '';
    this.origin = origin || '';
    this.timeoutMs = timeoutMs || 90000;
  }

  headers() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.origin) headers.Origin = this.origin;
    if (this.token) headers['X-Arena-Token'] = this.token;
    return headers;
  }

  async #request(operation, payload, { signal = null, timeoutMs = this.timeoutMs } = {}) {
    if (!this.bridgeUrl) {
      throw new DafeiyuError('not_configured', '尚未配置大肥鱼服务地址。', { retryable: false });
    }
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
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
    try {
      const response = await fetch(joinUrl(this.bridgeUrl, this.apiBase, operation), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // 计时器必须覆盖响应正文，不能只覆盖 fetch 拿到响应头之前。
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // 保留状态码，错误信息使用固定文案。
      }
      if (!response.ok) {
        if (response.status === 403) {
          throw new DafeiyuError('forbidden', '大肥鱼拒绝了这个来源：请检查桌宠的 arena_origins 和令牌配置。', {
            status: 403,
            retryable: false,
          });
        }
        if (response.status === 401) {
          throw new DafeiyuError('auth', '大肥鱼接入令牌不正确。', { status: 401, retryable: false });
        }
        if (response.status === 404) {
          throw new DafeiyuError(
            'unsupported',
            '大肥鱼服务没有竞技场接口，请安装包含 arena_routes.py 的桌宠版本。',
            { status: 404, retryable: false },
          );
        }
        const upstreamMessage = typeof data?.error?.message === 'string'
          ? data.error.message.slice(0, 300)
          : '';
        if (response.status >= 500) {
          throw new DafeiyuError(
            data?.error?.code ?? `http_${response.status}`,
            `大肥鱼服务暂时不可用（HTTP ${response.status}）${upstreamMessage ? `：${upstreamMessage}` : '。'}`,
            { status: response.status, retryable: true },
          );
        }
        throw new DafeiyuError(
          data?.error?.code ?? `http_${response.status}`,
          upstreamMessage || `大肥鱼服务返回 HTTP ${response.status}。`,
          { status: response.status, retryable: false },
        );
      }
      if (!data || data.ok !== true) {
        throw new DafeiyuError(
          data?.error?.code ?? 'invalid_response',
          data?.error?.message ?? '大肥鱼服务返回了无法识别的结果。',
        );
      }
      return data;
    } catch (error) {
      if (error instanceof DafeiyuError) throw error;
      if (timedOut) {
        throw new DafeiyuError('timeout', `大肥鱼服务在 ${Math.round(timeoutMs / 1000)} 秒内未完成响应。`);
      }
      if (cancelled) {
        throw new DafeiyuError('cancelled', '大肥鱼请求已取消。', { retryable: false });
      }
      throw new DafeiyuError(
        'unreachable',
        '大肥鱼服务不可达，请确认桌宠后端已启动且地址、端口正确。',
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  connect({ matchId, client = 'AI Arena' } = {}) {
    return this.#request('connect', { matchId, client });
  }

  status({ sessionId, matchId }) {
    return this.#request('status', { sessionId, matchId }, { timeoutMs: Math.min(this.timeoutMs, 12000) });
  }

  comment({ sessionId, matchId, role, seat, snapshot, event, mode, signal = null }) {
    return this.#request('comment', { sessionId, matchId, role, seat, snapshot, event, mode }, { signal });
  }

  question({ sessionId, matchId, role, seat, snapshot, question, signal = null }) {
    return this.#request('question', { sessionId, matchId, role, seat, snapshot, question }, { signal });
  }

  move({ sessionId, matchId, seat, snapshot, feedback = '', requestId = '', signal = null, timeoutMs = this.timeoutMs }) {
    return this.#request('move', { sessionId, matchId, seat, snapshot, feedback, requestId }, { signal, timeoutMs: Math.min(timeoutMs, this.timeoutMs) });
  }

  speak({ sessionId, matchId, text, key }) {
    return this.#request('speak', { sessionId, matchId, text, key }, { timeoutMs: Math.min(this.timeoutMs, 20000) });
  }

  cancelSpeech({ sessionId, matchId }) {
    return this.#request('speak-cancel', { sessionId, matchId }, { timeoutMs: 5000 });
  }

  leave({ sessionId, matchId }) {
    return this.#request('leave', { sessionId, matchId }, { timeoutMs: 5000 });
  }

  async ping() {
    if (!this.bridgeUrl) {
      return { online: false, message: '尚未配置大肥鱼服务地址。' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${this.bridgeUrl}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { online: false, message: `桌宠健康接口返回 HTTP ${response.status}。` };
      const data = await response.json();
      if (data?.ok !== true) {
        return { online: false, message: '桌宠健康接口报告服务未就绪。' };
      }
      return {
        online: true,
        message: '大肥鱼桌宠后端在线。',
        bridgeVersion: data.bridge_version ?? null,
        arena: Boolean(data.arena_game),
      };
    } catch {
      return {
        online: false,
        message: '大肥鱼桌宠后端不可达，请检查桌宠是否启动以及服务地址。',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
