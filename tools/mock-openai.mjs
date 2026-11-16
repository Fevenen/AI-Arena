#!/usr/bin/env node
/**
 * 零依赖 OpenAI 兼容模拟服务，供本机试玩和验收使用。
 *
 * 启动：
 *   node tools/mock-openai.mjs
 * 可选环境变量：
 *   MOCK_OPENAI_PORT=18999
 *   MOCK_OPENAI_KEY=local       # 设为空字符串表示不校验 Key
 *   MOCK_OPENAI_MODEL=mock-gomoku
 *
 * 它会根据竞技场发来的五子棋棋盘选择合法空点，不会访问任何网络服务。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_OPENAI_PORT || 18999);
const HOST = process.env.MOCK_OPENAI_HOST || '127.0.0.1';
const KEY = process.env.MOCK_OPENAI_KEY ?? 'local';
const MODEL = process.env.MOCK_OPENAI_MODEL || 'mock-gomoku';
const COLUMNS = 'ABCDEFGHIJKLMNO';

function boardFromMessages(messages) {
  const text = messages.map((item) => String(item.content ?? '')).join('\n');
  const board = Array.from({ length: 15 }, () => Array(15).fill(null));
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(\d{1,2})\s+((?:[BW.]\s*){15})$/.exec(line);
    if (!match) continue;
    const row = 15 - Number(match[1]);
    if (row < 0 || row > 14) continue;
    const cells = match[2].trim().split(/\s+/);
    cells.forEach((cell, col) => {
      if (cell === 'B') board[row][col] = 'black';
      else if (cell === 'W') board[row][col] = 'white';
    });
  }
  return board;
}

function seatFromMessages(messages) {
  const text = messages.map((item) => String(item.content ?? '')).join('\n');
  if (/你执\s*黑方|seat[”"\s:]+black/i.test(text)) return 'black';
  if (/你执\s*白方|seat[”"\s:]+white/i.test(text)) return 'white';
  return 'black';
}

function wouldWin(board, row, col, color) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of directions) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < 15 && c >= 0 && c < 15 && board[r][c] === color) {
        count += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (count >= 5) return true;
  }
  return false;
}

function chooseMove(board, seat) {
  const other = seat === 'black' ? 'white' : 'black';
  const empty = [];
  for (let row = 0; row < 15; row += 1) {
    for (let col = 0; col < 15; col += 1) {
      if (board[row][col] == null) empty.push({ row, col });
    }
  }
  if (!empty.length) return null;
  const centerScore = (cell) => Math.abs(cell.row - 7) + Math.abs(cell.col - 7);
  empty.sort((a, b) => centerScore(a) - centerScore(b));
  for (const cell of empty) {
    if (wouldWin(board, cell.row, cell.col, seat)) return cell;
  }
  for (const cell of empty) {
    if (wouldWin(board, cell.row, cell.col, other)) return cell;
  }
  return empty[0];
}

function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, service: 'mock-openai', model: MODEL });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (KEY && req.headers.authorization !== `Bearer ${KEY}`) {
      json(res, 401, { error: { message: 'invalid api key' } });
      return;
    }
    json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    json(res, 404, { error: { message: 'not found' } });
    return;
  }
  if (KEY && req.headers.authorization !== `Bearer ${KEY}`) {
    json(res, 401, { error: { message: 'invalid api key', code: 'invalid_api_key' } });
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: { message: 'invalid json' } });
    return;
  }
  if (body.model !== MODEL) {
    json(res, 404, { error: { message: `The model '${body.model}' does not exist`, code: 'model_not_found' } });
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const combined = messages.map((item) => String(item.content ?? '')).join('\n');
  let content = 'OK';
  if (!/只回复\s*OK|连接测试/.test(combined) || Number(body.max_tokens) > 16) {
    const board = boardFromMessages(messages);
    const seat = seatFromMessages(messages);
    const cell = chooseMove(board, seat);
    content = cell
      ? JSON.stringify({ move: `${COLUMNS[cell.col]}${15 - cell.row}`, say: '模拟模型选一个空点。' })
      : JSON.stringify({ move: 'H8', say: '' });
  }
  const response = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  json(res, 200, response);
});

server.listen(PORT, HOST, () => {
  console.log(`AI Arena mock OpenAI listening on http://${HOST}:${PORT}/v1`);
  console.log(`Model ID: ${MODEL}`);
  console.log(`API Key: ${KEY || '(空 / 不校验)'}`);
  console.log('Press Ctrl+C to stop.');
});
