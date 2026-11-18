import { defineGamePlugin } from '../../core/game-api.mjs';
import {
  SIZE,
  COLUMNS,
  ROWS_FROM_TOP,
  DIRECTIONS,
  cellToCoord,
  parseCoordinate,
  createEmptyBoard,
  cloneBoard,
  opposite,
  seatLabel,
  findWinningLine,
  isBoardFull,
  wouldWin,
  boardAsText,
} from './rules.mjs';

export const COORDINATE_SYSTEM = {
  columns: 'A-O，从左到右',
  rows: '15-1，从上到下',
  example: 'H8',
  note: 'H8 为正中央天元。界面、提示、记录和回放都使用这一坐标。',
};

export const RULES_TEXT = [
  '自由五子棋，15×15 棋盘。',
  '黑方先手，双方轮流在空点落下一子。',
  '无禁手、无交换、无让子。',
  '横、竖或任一斜线连续五子及以上即获胜（长连也算胜）。',
  '棋盘下满且无人获胜时和棋。',
].join('\n');

function validationError(state, seat, action) {
  if (state.outcome) {
    return { ok: false, code: 'game_over', message: '对局已经结束，不能继续落子。' };
  }
  if (seat !== 'black' && seat !== 'white') {
    return { ok: false, code: 'unknown_seat', message: '只能由黑方或白方落子。' };
  }
  if (state.turn !== seat) {
    return {
      ok: false,
      code: 'wrong_turn',
      message: `现在轮到${seatLabel(state.turn)}，${seatLabel(seat)}不能落子。`,
    };
  }
  if (!action || typeof action !== 'object' || action.type !== 'place') {
    return { ok: false, code: 'invalid_action', message: '动作格式必须是 {"type":"place","move":"H8"}。' };
  }
  const parsed = parseCoordinate(action.move);
  if (!parsed.ok) return parsed;
  if (state.board[parsed.row][parsed.col] != null) {
    return {
      ok: false,
      code: 'occupied',
      message: `${parsed.move} 已经有棋子，请选择空点。`,
      details: { move: parsed.move },
    };
  }
  return { ok: true, action: { type: 'place', move: parsed.move }, parsed };
}

function applyAction(state, seat, action) {
  const checked = validationError(state, seat, action);
  if (!checked.ok) {
    const error = new Error(checked.message);
    error.code = checked.code;
    error.details = checked.details ?? null;
    throw error;
  }
  const { parsed } = checked;
  const board = cloneBoard(state.board);
  board[parsed.row][parsed.col] = seat;
  const moveCount = state.moveCount + 1;
  const winning = findWinningLine(board, parsed.row, parsed.col, seat);
  let outcome = null;
  if (winning) {
    outcome = {
      type: 'win',
      winnerSeat: seat,
      winnerLabel: seatLabel(seat),
      move: parsed.move,
      line: winning.cells,
      direction: winning.direction,
      length: winning.cells.length,
    };
  } else if (isBoardFull(board)) {
    outcome = { type: 'draw', winnerSeat: null, winnerLabel: null };
  }
  const nextState = {
    ...state,
    board,
    moveCount,
    turn: outcome ? null : opposite(seat),
    lastMove: {
      seat,
      move: parsed.move,
      row: parsed.row,
      col: parsed.col,
      index: moveCount,
    },
    outcome,
    winningLine: winning ? winning.cells : null,
  };
  return {
    state: nextState,
    event: {
      type: 'move',
      seat,
      seatLabel: seatLabel(seat),
      move: parsed.move,
      row: parsed.row,
      col: parsed.col,
      index: moveCount,
      outcome,
    },
  };
}

function publicBoard(board) {
  return board.map((row) => row.slice());
}

function createInitialState() {
  const state = {
    size: SIZE,
    board: createEmptyBoard(),
    turn: 'black',
    moveCount: 0,
    lastMove: null,
    outcome: null,
    winningLine: null,
  };
  return state;
}

function getPublicState(state) {
  return {
    gameId: 'gomoku',
    size: SIZE,
    columns: COLUMNS,
    rowLabels: ROWS_FROM_TOP,
    coordinateSystem: COORDINATE_SYSTEM,
    board: publicBoard(state.board),
    turn: state.turn,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    outcome: state.outcome,
    winningLine: state.winningLine,
  };
}

function seatView(state, seatId) {
  return { ...getPublicState(state), yourSeat: seatId };
}

function legalActions(state, seatId) {
  if (state.outcome || state.turn !== seatId) return [];
  const actions = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (state.board[row][col] == null) {
        actions.push({ type: 'place', move: cellToCoord(row, col) });
      }
    }
  }
  return actions;
}

function getOutcome(state) {
  return state.outcome;
}

function describeForModel({ state, seatId, recentActions = [], allowSpeech = false }) {
  return {
    gameName: '自由五子棋',
    rulesText: RULES_TEXT,
    rulesVersion: '1.0.0',
    seatId,
    seatLabel: seatLabel(seatId),
    turn: state.turn,
    boardText: boardAsText(state.board),
    coordinateSystem: COORDINATE_SYSTEM,
    lastMove: state.lastMove,
    recentActions,
    responseFormat: allowSpeech
      ? '{"move":"H8","say":"可选的一句公开想法，30字以内"}'
      : '{"move":"H8"}',
    forbidden: '无禁手；长连（超过五子）同样获胜。',
  };
}

/**
 * 严格结构化解析：只接受一个完整的 JSON 对象。
 * 不再从自由文本中抓第一个坐标，避免“考虑 H8，但最终选 I8”被误判。
 */
function parseModelMove(content) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '模型返回了空内容。' };
  let candidate = text;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) {
    candidate = fenced[1].trim();
  } else if (text.includes('```')) {
    return { ok: false, error: '输出包含不完整的 Markdown 代码围栏。' };
  }
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    return { ok: false, error: '输出必须是单个完整 JSON 对象，不能包含解释文字。' };
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: '输出 JSON 被截断或格式错误。' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '输出必须是单个 JSON 对象。' };
  }
  if (parsed.moves != null || parsed.actions != null) {
    return { ok: false, error: '一次只能提交一个落子，不能返回动作数组。' };
  }
  if (typeof parsed.move !== 'string') {
    return { ok: false, error: 'JSON 中缺少字符串类型的 move 字段。' };
  }
  if (parsed.say != null && typeof parsed.say !== 'string') {
    return { ok: false, error: 'JSON 中的 say 必须是字符串。' };
  }
  const parsedCoordinate = parseCoordinate(parsed.move);
  if (!parsedCoordinate.ok) {
    return { ok: false, error: parsedCoordinate.message };
  }
  return {
    ok: true,
    action: { type: 'place', move: parsedCoordinate.move },
    say: String(parsed.say ?? '').trim().slice(0, 120),
  };
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText ?? 'arena')) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shapeScore(board, row, col, seat, deltaRow, deltaCol) {
  let count = 1;
  let openEnds = 0;
  for (const sign of [-1, 1]) {
    let r = row + deltaRow * sign;
    let c = col + deltaCol * sign;
    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === seat) {
      count += 1;
      r += deltaRow * sign;
      c += deltaCol * sign;
    }
    if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] == null) {
      openEnds += 1;
    }
  }
  const base = [0, 1, 12, 120, 2200][Math.min(count, 4)];
  return count >= 5 ? 1_000_000 : base * (openEnds === 2 ? 1.6 : openEnds === 1 ? 1 : 0.25);
}

function chooseBotAction({ state, seat, seed }) {
  if (state.outcome) throw new Error('对局已结束，机器人不能落子。');
  if (state.turn !== seat) throw new Error('还没轮到内置机器人。');
  const opponent = opposite(seat);
  const board = state.board.map((row) => row.slice());
  const empties = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (board[row][col] == null) empties.push({ row, col, move: cellToCoord(row, col) });
    }
  }
  if (!empties.length) throw new Error('棋盘已满。');
  if (state.moveCount === 0) return { type: 'place', move: 'H8' };

  for (const candidate of empties) {
    if (wouldWin(board, candidate.row, candidate.col, seat)) {
      return { type: 'place', move: candidate.move };
    }
  }
  const blocks = empties.filter((candidate) => wouldWin(board, candidate.row, candidate.col, opponent));
  if (blocks.length) {
    const random = seededRandom(`${seed}:${state.moveCount}:block`);
    blocks.sort((a, b) => {
      const da = Math.abs(a.row - 7) + Math.abs(a.col - 7);
      const db = Math.abs(b.row - 7) + Math.abs(b.col - 7);
      return da - db;
    });
    const pick = blocks[Math.floor(random() * Math.min(blocks.length, 2))];
    return { type: 'place', move: pick.move };
  }

  // 在普通棋形评分之前先识别“下一手有两个成五点”的双重威胁。
  // 这类棋不需要多步搜索，却是固定局面里最容易被普通启发式忽略的一手。
  const tactical = getTacticalHints({ state, seatId: seat });
  if (tactical.doubleThreatMoves.length) {
    const random = seededRandom(`${seed}:${state.moveCount}:double`);
    const candidates = tactical.doubleThreatMoves
      .map((move) => {
        const col = 'ABCDEFGHIJKLMNO'.indexOf(move[0]);
        const row = 15 - Number(move.slice(1));
        const center = 14 - (Math.abs(row - 7) + Math.abs(col - 7));
        return { move, score: center + random() * 4 };
      })
      .sort((a, b) => b.score - a.score);
    return { type: 'place', move: candidates[0].move };
  }

  const random = seededRandom(`${seed}:${state.moveCount}`);
  const scored = [];
  for (const candidate of empties) {
    let nearby = false;
    for (let r = Math.max(0, candidate.row - 2); r <= Math.min(SIZE - 1, candidate.row + 2); r += 1) {
      for (let c = Math.max(0, candidate.col - 2); c <= Math.min(SIZE - 1, candidate.col + 2); c += 1) {
        if (board[r][c] != null) nearby = true;
      }
    }
    if (!nearby) continue;
    let attack = 0;
    let defense = 0;
    for (const direction of DIRECTIONS) {
      attack += shapeScore(board, candidate.row, candidate.col, seat, direction.row, direction.col);
      defense += shapeScore(board, candidate.row, candidate.col, opponent, direction.row, direction.col);
    }
    const center = 14 - (Math.abs(candidate.row - 7) + Math.abs(candidate.col - 7));
    const score = attack + defense * 0.92 + center * 1.5 + random() * 4;
    scored.push({ ...candidate, score });
  }
  if (!scored.length) {
    const pick = empties[Math.floor(random() * empties.length)];
    return { type: 'place', move: pick.move };
  }
  scored.sort((a, b) => b.score - a.score);
  // 在前三名中带一点确定性扰动，避免每局完全相同，同时不做明显坏棋。
  const top = scored.slice(0, Math.min(3, scored.length));
  const index = random() < 0.7 ? 0 : Math.floor(random() * top.length);
  return { type: 'place', move: top[index].move };
}

function getTacticalHints({ state, seatId }) {
  if (state.outcome || state.turn !== seatId) {
    return {
      legalActions: [],
      immediateWins: [],
      mustBlocks: [],
      doubleThreatMoves: [],
      notes: ['当前不是该座位行动，或对局已经结束。'],
    };
  }
  const board = state.board.map((row) => row.slice());
  const opponent = opposite(seatId);
  const empties = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (board[row][col] == null) empties.push({ row, col, move: cellToCoord(row, col) });
    }
  }
  const immediateWins = [];
  const mustBlocks = [];
  for (const cell of empties) {
    if (wouldWin(board, cell.row, cell.col, seatId)) immediateWins.push(cell.move);
    if (wouldWin(board, cell.row, cell.col, opponent)) mustBlocks.push(cell.move);
  }
  const doubleThreatMoves = [];
  for (const cell of empties) {
    if (immediateWins.includes(cell.move)) continue;
    const copy = board.map((row) => row.slice());
    copy[cell.row][cell.col] = seatId;
    let wins = 0;
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        if (copy[row][col] == null && wouldWin(copy, row, col, seatId)) wins += 1;
      }
    }
    if (wins >= 2) doubleThreatMoves.push(cell.move);
  }
  return {
    legalActions: empties.map((cell) => ({ type: 'place', move: cell.move })),
    immediateWins,
    mustBlocks,
    doubleThreatMoves: doubleThreatMoves.slice(0, 12),
    notes: [
      immediateWins.length ? `立即成五点：${immediateWins.join('、')}` : '当前没有立即成五点。',
      mustBlocks.length ? `必须堵住的对方成五点：${mustBlocks.join('、')}` : '对方当前没有立即成五点。',
      doubleThreatMoves.length ? `可能形成双威胁的落点：${doubleThreatMoves.slice(0, 12).join('、')}` : '未发现明显的双威胁落点。',
    ],
  };
}

function describeAction(action) {
  return action?.move ? String(action.move) : JSON.stringify(action ?? {});
}

function autoCommentCandidates({ state, action }) {
  const events = [];
  if (state.outcome) {
    if (state.outcome.type === 'win') {
      events.push({
        key: `end:win:${state.outcome.winnerSeat}:${state.moveCount}`,
        type: 'game_end',
        priority: 100,
        summary: state.outcome.move
          ? `${seatLabel(action.seat)}以 ${state.outcome.move} 落子，连成 ${state.outcome.length} 子获胜。`
          : `${seatLabel(action.seat)}连成 ${state.outcome.length} 子获胜。`,
        details: {
          move: state.outcome.move ?? action?.action?.move ?? action?.move ?? null,
          winnerSeat: state.outcome.winnerSeat,
          line: state.outcome.line,
          length: state.outcome.length,
        },
      });
    } else {
      events.push({
        key: `end:draw:${state.moveCount}`,
        type: 'game_draw',
        priority: 95,
        summary: '棋盘已满，双方和棋。',
      });
    }
    return events;
  }

  const board = state.board.map((row) => row.slice());
  const seen = new Set();
  const threatSeats = [state.turn, opposite(state.turn)];
  const threats = [];
  for (const threatSeat of threatSeats) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        if (board[row][col] != null) continue;
        const coordinate = cellToCoord(row, col);
        if (seen.has(`${threatSeat}:${coordinate}`)) continue;
        if (wouldWin(board, row, col, threatSeat)) {
          seen.add(`${threatSeat}:${coordinate}`);
          threats.push({ seat: threatSeat, move: coordinate });
        }
      }
    }
  }
  for (const threat of threats.slice(0, 6)) {
    events.push({
      key: `threat:${threat.seat}:${threat.move}`,
      type: 'threat',
      priority: 50,
      summary: `${seatLabel(threat.seat)}下一手在 ${threat.move} 可以成五。`,
      details: { seat: threat.seat, move: threat.move },
    });
  }
  return events;
}

export const gomokuGame = defineGamePlugin({
  id: 'gomoku',
  name: '自由五子棋',
  shortName: '五子棋',
  description: '15×15 无禁手自由五子棋。黑先，横竖斜任意方向连成五子及以上获胜。',
  rulesVersion: '1.0.0',
  minPlayers: 2,
  maxPlayers: 2,
  supportsSpectator: true,
  seats: [
    { id: 'black', name: '黑方', shortName: '黑', color: 'black', order: 1 },
    { id: 'white', name: '白方', shortName: '白', color: 'white', order: 2 },
  ],
  rulesText: RULES_TEXT,
  coordinateSystem: COORDINATE_SYSTEM,
  createInitialState,
  getPublicState,
  getSeatView: seatView,
  getCurrentActor: (state) => state.turn,
  legalActions,
  validateAction: validationError,
  applyAction,
  getOutcome,
  describeForModel,
  parseModelMove,
  describeAction,
  getTacticalHints,
  chooseBotAction,
  autoCommentCandidates,
  // UI 需要的方向表，避免前端重复发明规则。
  ui: {
    kind: 'grid',
    rows: SIZE,
    columns: SIZE,
    showCoordinates: true,
  },
  directions: DIRECTIONS,
});

export default gomokuGame;
