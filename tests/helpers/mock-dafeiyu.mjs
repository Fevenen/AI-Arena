import http from 'node:http';
import { randomUUID } from 'node:crypto';

const COLUMNS = 'ABCDEFGHIJKLMNO';

function chooseEmptyMove(board) {
  const candidates = [];
  for (let row = 0; row < 15; row += 1) {
    for (let col = 0; col < 15; col += 1) {
      if (board?.[row]?.[col] == null) {
        const distance = Math.abs(row - 7) + Math.abs(col - 7);
        candidates.push({ row, col, distance });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const pick = candidates[0];
  return pick ? `${COLUMNS[pick.col]}${15 - pick.row}` : 'H8';
}

/**
 * 模拟桌宠 arena 桥接。用于离线端到端验证；
 * 真实联测时由测试脚本指向本机实际运行的桌宠 HTTP 接口。
 */
export async function createMockDafeiyu(options = {}) {
  const state = {
    online: true,
    allowedOrigin: options.allowedOrigin ?? null,
    token: options.token ?? null,
    sessions: new Map(),
    requests: [],
    commentDelayMs: options.commentDelayMs ?? 0,
    questionDelayMs: options.questionDelayMs ?? 0,
    moveDelayMs: options.moveDelayMs ?? 0,
    speechKeys: [],
    speechCancelled: 0,
    commentText: options.commentText ?? ((event) => {
      if (event?.type === 'game_end') return '这局下完啦，主人辛苦，本鲸都看着呢。';
      if (event?.type === 'game_draw') return '满盘都没分出胜负，行吧，本鲸勉强陪你再来一局。';
      if (event?.type === 'threat') return '哟，这里下一步就要成五了，别装作没看见。';
      return '这步还行，本鲸看着呢。';
    }),
    answerText: options.answerText ?? (() => '黑棋右边那条线有潜在威胁，先把要命的空点处理掉。'),
    moveResponder: options.moveResponder ?? null,
    moveFailure: options.moveFailure ?? null,
    commentFailure: options.commentFailure ?? null,
    speakStatus: options.speakStatus ?? 'queued',
    offlineCode: 503,
    personaName: '大肥鱼（模拟）',
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      if (res.destroyed) return;
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (req.method === 'GET' && req.url === '/api/health') {
      send(200, {
        ok: !state.online ? false : true,
        service: 'pet',
        bridge_version: 'test',
        arena_game: true,
        clients: 1,
      });
      return;
    }
    if (!state.online) {
      send(state.offlineCode, { ok: false, error: { code: 'offline', message: 'mock pet offline' } });
      return;
    }
    if (state.allowedOrigin && req.headers.origin !== state.allowedOrigin) {
      send(403, { ok: false, error: { code: 'origin_rejected', message: 'origin' } });
      return;
    }
    if (state.token && req.headers['x-arena-token'] !== state.token) {
      send(401, { ok: false, error: { code: 'auth', message: 'token' } });
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      send(400, { ok: false, error: { code: 'bad_json', message: 'bad json' } });
      return;
    }
    const op = String(req.url ?? '').split('/').at(-1);
    state.requests.push({
      op,
      at: Date.now(),
      headers: req.headers,
      body,
    });
    if (op === 'connect') {
      const sessionId = randomUUID();
      state.sessions.set(sessionId, { sessionId, matchId: body.matchId, createdAt: Date.now() });
      send(200, {
        ok: true,
        sessionId,
        personaName: state.personaName,
        service: { name: 'pet-test', version: 'test' },
        capabilities: ['comment', 'question', 'move', 'speak', 'status'],
      });
      return;
    }
    const session = state.sessions.get(body.sessionId);
    if (!session) {
      send(404, { ok: false, error: { code: 'session_not_found', message: 'session expired' } });
      return;
    }
    if (op === 'status') {
      send(200, { ok: true, connected: true, personaName: state.personaName });
      return;
    }
    if (op === 'comment') {
      if (state.commentDelayMs) await new Promise((resolve) => setTimeout(resolve, state.commentDelayMs));
      if (res.destroyed) return;
      if (state.commentFailure) {
        send(state.commentFailure.status ?? 500, {
          ok: false,
          error: {
            code: state.commentFailure.code ?? 'model_error',
            message: state.commentFailure.message ?? 'mock comment failure',
          },
        });
        return;
      }
      const event = body.event;
      const text = typeof state.commentText === 'function'
        ? await state.commentText(event, body)
        : String(state.commentText ?? '');
      send(200, {
        ok: true,
        text,
        personaName: state.personaName,
        eventKey: event?.key ?? null,
      });
      return;
    }
    if (op === 'question') {
      if (state.questionDelayMs) await new Promise((resolve) => setTimeout(resolve, state.questionDelayMs));
      if (res.destroyed) return;
      const answer = typeof state.answerText === 'function'
        ? await state.answerText(body.question, body)
        : String(state.answerText ?? '');
      send(200, { ok: true, text: answer, personaName: state.personaName });
      return;
    }
    if (op === 'move') {
      if (state.moveDelayMs) await new Promise((resolve) => setTimeout(resolve, state.moveDelayMs));
      if (res.destroyed) return;
      if (state.moveFailure) {
        send(state.moveFailure.status ?? 500, {
          ok: false,
          error: {
            code: state.moveFailure.code ?? 'model_error',
            message: state.moveFailure.message ?? 'mock move failure',
          },
        });
        return;
      }
      let rawText;
      if (state.moveResponder) {
        rawText = await state.moveResponder(body, state);
      } else {
        const board = body.snapshot?.state?.board;
        const move = chooseEmptyMove(board);
        rawText = JSON.stringify({ move, say: '本鲸先占这里，别催。' });
      }
      send(200, { ok: true, raw: rawText, say: '本鲸先占这里，别催。', personaName: state.personaName });
      return;
    }
    if (op === 'speak') {
      if (body.key) state.speechKeys.push(body.key);
      if (options.speakDelayMs) await new Promise((resolve) => setTimeout(resolve, options.speakDelayMs));
      send(200, { ok: true, voiceStatus: state.speakStatus });
      return;
    }
    if (op === 'speak-cancel') {
      state.speechCancelled += state.speechKeys.length;
      state.speechKeys = [];
      send(200, { ok: true, cancelled: 1 });
      return;
    }
    if (op === 'leave') {
      state.sessions.delete(body.sessionId);
      send(200, { ok: true });
      return;
    }
    send(404, { ok: false, error: { code: 'unknown_op', message: 'unknown' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    requests: state.requests,
    requestsFor(op) {
      return state.requests.filter((item) => item.op === op);
    },
    setOnline(value) {
      state.online = value;
    },
    setMoveFailure(value) {
      state.moveFailure = value;
    },
    setCommentFailure(value) {
      state.commentFailure = value;
    },
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
