/**
 * 本机 SSE 广播。订阅数同时用于判断当前对局是否仍有人观看：
 * 离开回放/切换对局后，迟到的大肥鱼自动点评不会落盘。
 */
export class EventHub {
  constructor({ heartbeatMs = 20000 } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.streams = new Map();
    this.heartbeat = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.heartbeat = setInterval(() => {
      for (const set of this.streams.values()) {
        for (const res of set) {
          try {
            res.write(':ping\n\n');
          } catch {
            set.delete(res);
          }
        }
      }
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  subscribe(matchId, res) {
    this.start();
    if (!this.streams.has(matchId)) this.streams.set(matchId, new Set());
    this.streams.get(matchId).add(res);
    return () => this.unsubscribe(matchId, res);
  }

  unsubscribe(matchId, res) {
    const set = this.streams.get(matchId);
    if (!set) return;
    set.delete(res);
    if (!set.size) this.streams.delete(matchId);
  }

  count(matchId) {
    return this.streams.get(matchId)?.size ?? 0;
  }

  publish(matchId, event, payload) {
    const set = this.streams.get(matchId);
    if (!set?.size) return;
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(data);
      } catch {
        set.delete(res);
      }
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.streams.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // 已关闭。
        }
      }
    }
    this.streams.clear();
  }
}
