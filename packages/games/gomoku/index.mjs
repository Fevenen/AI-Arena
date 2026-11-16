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

function describeForModel({ state, seatId, recentActions = [] }) {
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
    responseFormat: '{"move":"H8","say":"可选的一句公开想法，30字以内"}',
    forbidden: '无禁手；长连（超过五子）同样获胜。',
  };
}

function parseModelMove(content) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '模型返回了空内容。' };
  let parsed = null;
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  for (const candidate of [unfenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // 尝试下一种提取方式。
    }
  }
  let move = null;
  let say = '';
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.move === 'string') move = parsed.move;
    else if (parsed.action && typeof parsed.action.move === 'string') move = parsed.action.move;
    if (typeof parsed.say === 'string') say = parsed.say.trim().slice(0, 120);
    else if (typeof parsed.thought === 'string') say = parsed.thought.trim().slice(0, 120);
  }
  if (!move) {
    const labeled = /["']?move["']?\s*[:=]\s*["']?([A-Za-z]\d{1,2})/.exec(text);
    const bare = /\b([A-Oa-o]\d{1,2})\b/.exec(text);
    move = labeled?.[1] ?? bare?.[1] ?? null;
  }
  if (!move) {
    return { ok: false, error: '模型返回中没有可识别的 JSON move 字段。' };
  }
  const parsedCoordinate = parseCoordinate(move);
  if (!parsedCoordinate.ok) {
    return { ok: false, error: parsedCoordinate.message };
  }
  return {
    ok: true,
    action: { type: 'place', move: parsedCoordinate.move },
    say,
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

function autoCommentCandidates({ previous, state, action, chat = [] }) {
  const events = [];
  if (state.outcome) {
    if (state.outcome.type === 'win') {
      events.push({
        key: `end:win:${state.outcome.winnerSeat}:${state.moveCount}`,
        type: 'game_end',
        priority: 100,
        summary: `${seatLabel(action.seat)}以 ${action.move} 落子，连成 ${state.outcome.length} 子获胜。`,
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
    { id: 'black', name: '黑方', order: 1 },
    { id: 'white', name: '白方', order: 2 },
  ],
  rulesText: RULES_TEXT,
  coordinateSystem: COORDINATE_SYSTEM,
  createInitialState,
  getPublicState,
  getSeatView: seatView,
  legalActions,
  validateAction: validationError,
  applyAction,
  getOutcome,
  describeForModel,
  parseModelMove,
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
