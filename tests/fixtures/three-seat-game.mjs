import { defineGamePlugin } from '../../packages/core/game-api.mjs';

const SEATS = [
  { id: 'sun', name: '金席', shortName: '金', color: 'gold', order: 1 },
  { id: 'moon', name: '月席', shortName: '月', color: 'blue', order: 2 },
  { id: 'star', name: '星席', shortName: '星', color: 'violet', order: 3 },
];

const SEAT_IDS = SEATS.map((seat) => seat.id);
const TARGETS = { sun: 1, moon: 5, star: 9 };
const NOTES = {
  sun: 'SUN-SECRET-TARGET',
  moon: 'MOON-SECRET-TARGET',
  star: 'STAR-SECRET-TARGET',
};
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const RULES_TEXT = '3×3 三席测试局：金→月→星轮流占格；先连成三格者获胜。九格占满仍无三连时，只有自己私有目标格被自己占到的席位获胜；多人或无人达成则和棋。';

const label = (seat) => SEATS.find((item) => item.id === seat)?.name ?? seat;

function nextSeat(seat) {
  const index = SEAT_IDS.indexOf(seat);
  return SEAT_IDS[(index + 1) % SEAT_IDS.length];
}

function publicState(state) {
  return {
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
    outcome: state.outcome,
    seatOrder: [...SEAT_IDS],
  };
}

function seatView(state, seatId) {
  return {
    ...publicState(state),
    you: seatId,
    target: state.privateTargets[seatId],
    secretNote: state.privateNotes[seatId],
  };
}

function createInitialState({ seed = '' } = {}) {
  return {
    board: Array.from({ length: 3 }, () => Array(3).fill(null)),
    turn: 'sun',
    moveCount: 0,
    lastMove: null,
    outcome: null,
    seed,
    privateTargets: { ...TARGETS },
    privateNotes: { ...NOTES },
    randomEvents: [],
  };
}

function legalCells(state) {
  const cells = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (state.board[row][col] == null) cells.push(row * 3 + col + 1);
    }
  }
  return cells;
}

function checkLine(board, seat) {
  for (const line of LINES) {
    if (line.every((index) => board[Math.floor(index / 3)][index % 3] === seat)) return line;
  }
  return null;
}

function validateAction(state, seat, action) {
  if (state.outcome) return { ok: false, code: 'game_over', message: '对局已经结束。' };
  if (!SEAT_IDS.includes(seat)) return { ok: false, code: 'unknown_seat', message: '未知座位。' };
  if (state.turn !== seat) return { ok: false, code: 'wrong_turn', message: `现在轮到${label(state.turn)}。` };
  const cell = Number(action?.cell);
  if (!Number.isInteger(cell) || cell < 1 || cell > 9) {
    return { ok: false, code: 'invalid_action', message: 'cell 必须是 1 到 9 的整数。' };
  }
  const row = Math.floor((cell - 1) / 3);
  const col = (cell - 1) % 3;
  if (state.board[row][col] != null) {
    return { ok: false, code: 'occupied', message: '这一格已经有棋子。' };
  }
  return { ok: true, action: { cell } };
}

function applyAction(state, seat, action) {
  const checked = validateAction(state, seat, action);
  if (!checked.ok) {
    const error = new Error(checked.message);
    error.code = checked.code;
    throw error;
  }
  const board = state.board.map((row) => row.slice());
  const cell = checked.action.cell;
  const row = Math.floor((cell - 1) / 3);
  const col = (cell - 1) % 3;
  board[row][col] = seat;
  const moveCount = state.moveCount + 1;
  let outcome = null;
  const line = checkLine(board, seat);
  if (line) {
    outcome = {
      type: 'win',
      winnerSeat: seat,
      winnerLabel: label(seat),
      reason: 'three_in_line',
      line,
      length: 3,
      cell,
    };
  } else if (moveCount === 9) {
    const achieved = SEAT_IDS.filter((id) => {
      const target = TARGETS[id] - 1;
      return board[Math.floor(target / 3)][target % 3] === id;
    });
    if (achieved.length === 1) {
      outcome = {
        type: 'win',
        winnerSeat: achieved[0],
        winnerLabel: label(achieved[0]),
        reason: 'private_target',
        line: [],
        length: 0,
        cell,
      };
    } else {
      outcome = { type: 'draw', winnerSeat: null, winnerLabel: null, reason: 'no_unique_target' };
    }
  }
  const next = outcome ? null : nextSeat(seat);
  const nextState = {
    ...state,
    board,
    turn: next,
    moveCount,
    lastMove: { seat, cell, row, col, index: moveCount },
    outcome,
  };
  return {
    state: nextState,
    event: {
      type: 'move',
      seat,
      seatLabel: label(seat),
      action: { cell },
      cell,
      index: moveCount,
      outcome,
    },
  };
}

function describeForModel({ state, seatId, recentActions = [], allowSpeech = false }) {
  const view = seatView(state, seatId);
  return {
    gameName: '三席测试局',
    rulesText: RULES_TEXT,
    rulesVersion: '1.0.0',
    seatId,
    seatLabel: label(seatId),
    turn: state.turn,
    boardText: state.board.map((row) => row.map((cell) => cell ?? '.').join(' ')).join('\n'),
    privateTarget: view.target,
    privateNote: view.secretNote,
    privateContext: { target: view.target, note: view.secretNote },
    lastMove: state.lastMove,
    recentActions,
    responseFormat: allowSpeech ? '{"cell":5,"say":"可选的一句公开想法"}' : '{"cell":5}',
  };
}

function parseModelMove(content) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '模型返回了空内容。' };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    return { ok: false, error: '输出必须是单个完整 JSON 对象。' };
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
  if (parsed.cells != null || parsed.actions != null) {
    return { ok: false, error: '一次只能提交一个 cell。' };
  }
  const cell = Number(parsed.cell);
  if (!Number.isInteger(cell) || cell < 1 || cell > 9) {
    return { ok: false, error: 'cell 必须是 1 到 9 的整数。' };
  }
  return { ok: true, action: { cell }, say: String(parsed.say ?? '').slice(0, 120) };
}

function getTacticalHints({ state, seatId }) {
  const cells = legalCells(state);
  const canWin = cells.filter((cell) => {
    const row = Math.floor((cell - 1) / 3);
    const col = (cell - 1) % 3;
    const copy = state.board.map((line) => line.slice());
    copy[row][col] = seatId;
    return Boolean(checkLine(copy, seatId));
  });
  return {
    legalActions: cells.map((cell) => ({ cell })),
    immediateWins: canWin,
    mustBlocks: [],
    doubleThreatMoves: [],
    notes: [canWin.length ? `立即三连格：${canWin.join('、')}` : '没有立即三连格。'],
  };
}

function chooseBotAction({ state, seat }) {
  if (state.outcome) throw new Error('对局已结束。');
  if (state.turn !== seat) throw new Error('还没轮到该席位。');
  const cells = legalCells(state);
  if (!cells.length) throw new Error('没有空格。');
  const winning = getTacticalHints({ state, seatId: seat }).immediateWins;
  if (winning.length) return { cell: winning[0] };
  const target = state.privateTargets[seat];
  if (cells.includes(target)) return { cell: target };
  return { cell: cells[0] };
}

function describeAction(action) {
  return Number.isInteger(action?.cell) ? `第 ${action.cell} 格` : JSON.stringify(action ?? {});
}

function autoCommentCandidates({ state, action }) {
  if (!state.outcome) return [];
  if (state.outcome.type === 'win') {
    return [{
      key: `end:win:${state.outcome.winnerSeat}:${state.moveCount}`,
      type: 'game_end',
      priority: 100,
      summary: `${label(state.outcome.winnerSeat)}以第 ${state.outcome.cell} 格获胜。`,
      details: { cell: state.outcome.cell, winnerSeat: state.outcome.winnerSeat },
    }];
  }
  return [{
    key: `end:draw:${state.moveCount}`,
    type: 'game_draw',
    priority: 95,
    summary: '九格占满，没有唯一私有目标获胜者，和棋。',
  }];
}

export const threeSeatGame = defineGamePlugin({
  id: 'three-seat-test',
  name: '三席测试局',
  shortName: '三席',
  description: '仅用于开发/测试的三座位桌游，带私有目标格，验证通用座位、行动、可见性和回放。',
  rulesVersion: '1.0.0',
  minPlayers: 3,
  maxPlayers: 3,
  supportsSpectator: true,
  seats: SEATS,
  rulesText: RULES_TEXT,
  coordinateSystem: null,
  createInitialState,
  getPublicState: publicState,
  getSeatView: seatView,
  getCurrentActor: (state) => state.turn,
  legalActions: (state) => legalCells(state).map((cell) => ({ cell })),
  validateAction,
  applyAction,
  getOutcome: (state) => state.outcome,
  describeForModel,
  parseModelMove,
  describeAction,
  getTacticalHints,
  chooseBotAction,
  autoCommentCandidates,
  ui: {
    kind: 'three-seat-test',
    rows: 3,
    columns: 3,
    showCoordinates: false,
  },
});

export default threeSeatGame;
