import {
  PIECES,
  PIECE_MAP,
  getPiece,
  orientationCells,
  orientationFor,
  pieceCatalog,
  pieceSize,
} from './pieces.mjs';

export const SIZE = 14;
export const COLUMNS = 'ABCDEFGHIJKLMN';
export const SEATS = ['gold', 'blue'];
export const FIRST_SEAT = 'gold';
export const SECOND_SEAT = 'blue';
export const START_POINTS = [
  { index: 0, row: 4, col: 4, label: 'E5' },
  { index: 1, row: 9, col: 9, label: 'J10' },
];
export const MAX_ASSISTED_CANDIDATES = 80;

const ALL_PIECE_IDS = PIECES.map((piece) => piece.id);
const legalCache = new WeakMap();

function stateFingerprint(state) {
  const board = state.board.map((row) => row.map((value) => (
    value === FIRST_SEAT ? 'G' : value === SECOND_SEAT ? 'B' : '.'
  )).join('')).join('');
  return `${board}|${state.inventories.gold.join(',')}|${state.inventories.blue.join(',')}`
    + `|${state.firstMoves.gold ? 1 : 0}${state.firstMoves.blue ? 1 : 0}|${state.chosenStart ?? 'x'}`;
}

export function seatLabel(seat) {
  // The internal seat id stays "gold" for old snapshots; the player color is red.
  return seat === 'gold' ? '红方' : seat === 'blue' ? '蓝方' : String(seat ?? '未定');
}

export function oppositeSeat(seat) {
  return seat === 'gold' ? 'blue' : seat === 'blue' ? 'gold' : null;
}

export function cellLabel(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col)
    || row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
  return `${COLUMNS[col]}${row + 1}`;
}

export function parseAnchor(value) {
  const text = String(value ?? '').trim().toUpperCase();
  const match = /^([A-N])([1-9]|1[0-4])$/.exec(text);
  if (!match) {
    return { ok: false, code: 'invalid_anchor', message: '锚点必须写成 A1–N14 的格子坐标。' };
  }
  const col = COLUMNS.indexOf(match[1]);
  const row = Number(match[2]) - 1;
  return { ok: true, row, col, anchor: cellLabel(row, col) };
}

export function createEmptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function cloneStateShell(state) {
  return {
    ...state,
    board: cloneBoard(state.board),
    firstMoves: { ...state.firstMoves },
    passed: { ...state.passed },
    inventories: {
      gold: [...state.inventories.gold],
      blue: [...state.inventories.blue],
    },
    lastPlacedPiece: { ...state.lastPlacedPiece },
  };
}

export function createInitialState({ seed: _seed = null } = {}) {
  return {
    size: SIZE,
    board: createEmptyBoard(),
    turn: FIRST_SEAT,
    actionCount: 0,
    chosenStart: null,
    firstMoves: { [FIRST_SEAT]: false, [SECOND_SEAT]: false },
    passed: { [FIRST_SEAT]: false, [SECOND_SEAT]: false },
    inventories: {
      [FIRST_SEAT]: [...ALL_PIECE_IDS],
      [SECOND_SEAT]: [...ALL_PIECE_IDS],
    },
    lastPlacedPiece: { [FIRST_SEAT]: null, [SECOND_SEAT]: null },
    lastAction: null,
    outcome: null,
    scores: null,
  };
}

function reasonError(code, message, details = undefined) {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

function actionCells(action) {
  if (action?.row != null || action?.col != null) {
    if (!Number.isInteger(action.row) || !Number.isInteger(action.col)) return null;
    const anchor = cellLabel(action.row, action.col);
    if (!anchor) return null;
    return { ok: true, row: action.row, col: action.col, anchor };
  }
  return parseAnchor(action?.anchor);
}

function placementCellList(pieceId, orientationIndex, row, col) {
  const cells = orientationCells(pieceId, orientationIndex);
  return cells.map(([dr, dc]) => [row + dr, col + dc]);
}

function hasStart(cells, start) {
  return cells.some(([row, col]) => row === start.row && col === start.col);
}

function sortCells(cells) {
  return cells
    .map(([row, col]) => [row, col])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Geometric and Blokus placement checks. This is the single source of truth
 * for human, model, bot and Dafeiyu submissions.
 */
function checkPlacement(state, seat, pieceId, orientation, anchorRow, anchorCol) {
  if (state.outcome) return reasonError('game_over', '对局已经结束，不能继续落子。');
  if (!SEATS.includes(seat)) return reasonError('unknown_seat', '不存在的座位。');
  const piece = getPiece(pieceId);
  if (!piece) return reasonError('unknown_piece', `未知棋子：${pieceId}`);
  if (!state.inventories[seat].includes(piece.id)) {
    return reasonError('piece_used', `${piece.name} 已经用过了，不能重复使用。`);
  }
  if (!Number.isInteger(orientation) || orientation < 0 || orientation >= piece.orientations.length) {
    return reasonError(
      'unknown_orientation',
      `${piece.name} 没有朝向 ${orientation}；可用朝向为 0–${piece.orientations.length - 1}。`,
    );
  }
  if (!Number.isInteger(anchorRow) || !Number.isInteger(anchorCol)) {
    return reasonError('invalid_anchor', '锚点必须是棋盘内的格子。');
  }
  const cells = placementCellList(piece.id, orientation, anchorRow, anchorCol);
  const out = cells.find(([row, col]) => row < 0 || row >= SIZE || col < 0 || col >= SIZE);
  if (out) {
    return reasonError(
      'out_of_bounds',
      `${piece.name} 放在 ${cellLabel(anchorRow, anchorCol) ?? '棋盘外'} 会越界（${out[0]},${out[1]}）。`,
    );
  }
  const occupied = cells.find(([row, col]) => state.board[row][col] != null);
  if (occupied) {
    return reasonError(
      'occupied',
      `${piece.name} 会覆盖已有棋子：${cellLabel(occupied[0], occupied[1])}。`,
      { cell: cellLabel(occupied[0], occupied[1]) },
    );
  }

  const coveredStarts = START_POINTS.filter((start) => hasStart(cells, start));
  if (!state.firstMoves[seat]) {
    if (seat === FIRST_SEAT) {
      if (coveredStarts.length !== 1) {
        return reasonError(
          'start_required',
          '先手第一块必须覆盖 E5 或 J10 其中一个起始点。',
        );
      }
    } else {
      if (state.chosenStart == null) {
        return reasonError('start_not_chosen', '先手还没有选择起始点。');
      }
      const required = START_POINTS[1 - state.chosenStart];
      if (!coveredStarts.some((start) => start.index === required.index)) {
        return reasonError(
          'start_required',
          `后手第一块必须覆盖另一个起始点 ${required.label}。`,
        );
      }
      if (coveredStarts.some((start) => start.index === state.chosenStart)) {
        return reasonError('start_used', `起始点 ${START_POINTS[state.chosenStart].label} 已被先手使用。`);
      }
    }
  }

  let cornerContact = false;
  for (const [row, col] of cells) {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (state.board[nr][nc] === seat) {
        return reasonError(
          'edge_contact',
          `新棋块贴到了己方棋边：${cellLabel(row, col)} 与 ${cellLabel(nr, nc)}。`,
          { cell: cellLabel(row, col), other: cellLabel(nr, nc) },
        );
      }
    }
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
      if (state.board[nr][nc] === seat) cornerContact = true;
    }
  }
  if (state.firstMoves[seat] && !cornerContact) {
    return reasonError('no_corner', '新棋块必须至少与己方已有棋子角接触。');
  }

  return {
    ok: true,
    action: {
      type: 'place',
      pieceId: piece.id,
      orientation,
      anchor: cellLabel(anchorRow, anchorCol),
      row: anchorRow,
      col: anchorCol,
      cells: sortCells(cells),
    },
    cells: sortCells(cells),
    piece,
    coveredStarts: coveredStarts.map((start) => start.index),
  };
}

function resolveCandidate(state, seat, candidateId) {
  const result = candidateActions(state, seat);
  return result.candidates.find((candidate) => candidate.candidateId === candidateId) ?? null;
}

export function validateAction(state, seat, action) {
  if (state.outcome) return reasonError('game_over', '对局已经结束，不能继续落子。');
  if (!SEATS.includes(seat)) return reasonError('unknown_seat', '不存在的座位。');
  if (state.turn !== seat) {
    return reasonError('wrong_turn', `现在轮到${seatLabel(state.turn)}，${seatLabel(seat)}不能落子。`);
  }
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return reasonError('invalid_action', '动作必须是单个 JSON 对象。');
  }
  if (action.type === 'pass') {
    return validatePass(state, seat, action);
  }
  if (action.type !== 'place') {
    return reasonError('invalid_action', '动作格式必须是 {"type":"place",...} 或 {"type":"pass"}。');
  }
  const candidateId = action.candidate ?? action.candidateId ?? null;
  if (candidateId != null) {
    if (typeof candidateId !== 'string' || !candidateId.trim()) {
      return reasonError('invalid_candidate', '候选 ID 必须是非空字符串。');
    }
    if (action.pieceId != null || action.orientation != null || action.anchor != null
      || action.row != null || action.col != null) {
      return reasonError('ambiguous_action', '候选 ID 和完整棋子字段不能同时提交。');
    }
    const candidate = resolveCandidate(state, seat, candidateId.trim());
    if (!candidate) {
      return reasonError(
        'unknown_candidate',
        `候选 ${candidateId} 不在当前局面的辅助候选列表中。`,
      );
    }
    return {
      ok: true,
      action: candidate.action,
      candidateId: candidate.candidateId,
      cells: candidate.cells,
      piece: getPiece(candidate.pieceId),
    };
  }
  if (typeof action.pieceId !== 'string') {
    return reasonError('invalid_action', '动作缺少字符串 pieceId，或应使用 candidate ID。');
  }
  if (!Number.isInteger(action.orientation)) {
    return reasonError('invalid_action', 'orientation 必须是从 0 开始的整数。');
  }
  const anchor = actionCells(action);
  if (!anchor?.ok) {
    return reasonError(anchor?.code ?? 'invalid_anchor', anchor?.message ?? '锚点格式不正确。');
  }
  return checkPlacement(state, seat, action.pieceId, action.orientation, anchor.row, anchor.col);
}

function validatePass(state, seat, action) {
  if (state.outcome) return reasonError('game_over', '对局已经结束。');
  if (state.turn !== seat) {
    return reasonError('wrong_turn', `现在轮到${seatLabel(state.turn)}。`);
  }
  const legal = allLegalActions(state, seat);
  if (legal.length) {
    return reasonError(
      'must_place',
      `还有 ${legal.length} 个合法摆法，不能跳过；请先落子。`,
      { legalCount: legal.length },
    );
  }
  return {
    ok: true,
    action: { type: 'pass', reason: String(action.reason ?? 'no_legal_move').slice(0, 80) },
  };
}

export function allLegalActions(state, seat) {
  if (state.outcome || !SEATS.includes(seat)) return [];
  const fingerprint = stateFingerprint(state);
  let entry = legalCache.get(state);
  if (!entry || entry.fingerprint !== fingerprint) {
    entry = { fingerprint, bySeat: new Map() };
    legalCache.set(state, entry);
  }
  const bySeat = entry.bySeat;
  if (bySeat.has(seat)) return bySeat.get(seat);
  const actions = [];
  for (const pieceId of state.inventories[seat]) {
    const piece = PIECE_MAP.get(pieceId);
    if (!piece) continue;
    for (const orientation of piece.orientations) {
      const height = Math.max(...orientation.cells.map(([row]) => row)) + 1;
      const width = Math.max(...orientation.cells.map(([, col]) => col)) + 1;
      for (let row = 0; row <= SIZE - height; row += 1) {
        for (let col = 0; col <= SIZE - width; col += 1) {
          const checked = checkPlacement(state, seat, pieceId, orientation.index, row, col);
          if (checked.ok) actions.push(checked.action);
        }
      }
    }
  }
  // Stable order is part of the assisted-candidate contract.
  actions.sort((a, b) => (
    pieceSize(b.pieceId) - pieceSize(a.pieceId)
    || a.pieceId.localeCompare(b.pieceId)
    || a.orientation - b.orientation
    || a.row - b.row
    || a.col - b.col
  ));
  bySeat.set(seat, actions);
  return actions;
}

function placementScore(state, seat, action) {
  const board = state.board;
  let corners = 0;
  for (const [row, col] of action.cells) {
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] == null) corners += 1;
    }
  }
  const center = 14 - (Math.abs(action.row - 6.5) + Math.abs(action.col - 6.5));
  return pieceSize(action.pieceId) * 100 + corners * 3 + center;
}

/**
 * Deterministic, bounded assisted candidate set. The total count and the exact
 * filter are returned so the model and the record can distinguish "all legal"
 * from "a shown subset".
 */
export function candidateActions(state, seat, limit = MAX_ASSISTED_CANDIDATES) {
  const all = allLegalActions(state, seat);
  if (!all.length) {
    return { candidates: [], total: 0, shown: 0, filter: 'none', all: [] };
  }
  if (all.length <= limit) {
    return {
      candidates: all.map((action, index) => toCandidate(action, index)),
      total: all.length,
      shown: all.length,
      filter: 'all legal placements',
      all,
    };
  }
  const ranked = all
    .map((action) => ({ action, score: placementScore(state, seat, action) }))
    .sort((a, b) => b.score - a.score
      || pieceSize(b.action.pieceId) - pieceSize(a.action.pieceId)
      || a.action.pieceId.localeCompare(b.action.pieceId)
      || a.action.orientation - b.action.orientation
      || a.action.row - b.action.row
      || a.action.col - b.action.col);

  // Keep at least one placement for every remaining piece, then fill by score.
  const selected = [];
  const selectedKeys = new Set();
  const byPiece = new Map();
  for (const item of ranked) {
    if (!byPiece.has(item.action.pieceId)) byPiece.set(item.action.pieceId, []);
    byPiece.get(item.action.pieceId).push(item);
  }
  for (const pieceId of state.inventories[seat]) {
    const item = byPiece.get(pieceId)?.[0];
    if (item) {
      selected.push(item.action);
      selectedKeys.add(actionKey(item.action));
    }
  }
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(actionKey(item.action))) continue;
    selected.push(item.action);
    selectedKeys.add(actionKey(item.action));
  }
  selected.splice(limit);
  return {
    candidates: selected.map((action, index) => toCandidate(action, index)),
    total: all.length,
    shown: selected.length,
    filter: 'size/expansion/center rank; at least one per remaining piece; top 80',
    all,
  };
}

function actionKey(action) {
  return `${action.pieceId}:${action.orientation}:${action.row}:${action.col}`;
}

function toCandidate(action, index) {
  return {
    candidateId: `c${index + 1}`,
    pieceId: action.pieceId,
    orientation: action.orientation,
    anchor: action.anchor,
    cells: action.cells,
    size: pieceSize(action.pieceId),
    action,
  };
}

export function getTacticalHints({ state, seatId }) {
  if (state.outcome) {
    return {
      legalActions: [],
      immediateWins: [],
      mustBlocks: [],
      doubleThreatMoves: [],
      notes: ['对局已经结束。'],
      candidateInfo: { total: 0, shown: 0, filter: 'none' },
    };
  }
  if (state.turn !== seatId) {
    return {
      legalActions: [],
      immediateWins: [],
      mustBlocks: [],
      doubleThreatMoves: [],
      notes: ['当前不是该座位行动。'],
      candidateInfo: { total: 0, shown: 0, filter: 'none' },
    };
  }
  const result = candidateActions(state, seatId);
  return {
    legalActions: result.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      pieceId: candidate.pieceId,
      orientation: candidate.orientation,
      anchor: candidate.anchor,
      cells: candidate.cells,
      size: candidate.size,
    })),
    immediateWins: [],
    mustBlocks: [],
    doubleThreatMoves: [],
    notes: [
      `当前有 ${result.total} 个合法摆法，展示 ${result.shown} 个候选。`,
      `候选筛选：${result.filter}。`,
      '这是完整信息游戏；候选 ID 只在当前局面有效，提交一个 candidate 即可。',
      '每块必须与己方已有棋子角接触，不能与己方棋子边接触；异色贴边允许。',
    ],
    candidateInfo: {
      total: result.total,
      shown: result.shown,
      filter: result.filter,
      candidateLimit: MAX_ASSISTED_CANDIDATES,
    },
  };
}

export function legalActions(state, seatId) {
  return allLegalActions(state, seatId).map((action) => ({
    type: action.type,
    pieceId: action.pieceId,
    orientation: action.orientation,
    anchor: action.anchor,
    cells: action.cells,
  }));
}

function markFirstMove(state, seat, coveredStarts) {
  if (state.firstMoves[seat]) return;
  state.firstMoves[seat] = true;
  if (seat === FIRST_SEAT) {
    state.chosenStart = coveredStarts[0];
  }
}

export function applyAction(state, seat, rawAction) {
  const checked = validateAction(state, seat, rawAction);
  if (!checked.ok) {
    const error = new Error(checked.message);
    error.code = checked.code;
    error.details = checked.details ?? null;
    throw error;
  }
  const action = checked.action;
  const next = cloneStateShell(state);
  next.actionCount += 1;

  if (action.type === 'pass') {
    next.passed[seat] = true;
    next.lastAction = {
      index: next.actionCount,
      seat,
      action,
      type: 'pass',
      reason: action.reason,
    };
    const bothStuck = !allLegalActions(next, FIRST_SEAT).length
      && !allLegalActions(next, SECOND_SEAT).length;
    if (bothStuck) {
      settle(next, 'both_stuck');
    } else {
      next.turn = oppositeSeat(seat);
    }
    return {
      state: next,
      event: {
        type: 'pass',
        seat,
        seatLabel: seatLabel(seat),
        action,
        index: next.actionCount,
        reason: action.reason,
        outcome: next.outcome,
      },
    };
  }

  const piece = checked.piece;
  for (const [row, col] of checked.cells) next.board[row][col] = seat;
  next.inventories[seat] = next.inventories[seat].filter((id) => id !== piece.id);
  next.passed[seat] = false;
  next.lastPlacedPiece[seat] = piece.id;
  next.lastAction = {
    index: next.actionCount,
    seat,
    action,
    type: 'place',
    cells: checked.cells,
    pieceId: piece.id,
    orientation: action.orientation,
    anchor: action.anchor,
  };
  markFirstMove(next, seat, checked.coveredStarts);

  if (!next.inventories[seat].length) {
    settle(next, 'all_pieces');
  } else {
    const bothStuck = !allLegalActions(next, FIRST_SEAT).length
      && !allLegalActions(next, SECOND_SEAT).length;
    if (bothStuck) {
      settle(next, 'both_stuck');
    } else {
      next.turn = oppositeSeat(seat);
    }
  }

  return {
    state: next,
    event: {
      type: 'place',
      seat,
      seatLabel: seatLabel(seat),
      action,
      move: action.anchor,
      pieceId: piece.id,
      orientation: action.orientation,
      anchor: action.anchor,
      cells: checked.cells,
      index: next.actionCount,
      outcome: next.outcome,
    },
  };
}

function scoreSeat(state, seat) {
  const remaining = state.inventories[seat];
  const unusedSquares = remaining.reduce((sum, pieceId) => sum + pieceSize(pieceId), 0);
  const allPieces = remaining.length === 0;
  const lastPiece = state.lastPlacedPiece[seat];
  const allPiecesBonus = allPieces ? 15 : 0;
  const monominoBonus = allPieces && pieceSize(lastPiece) === 1 ? 5 : 0;
  return {
    seat,
    label: seatLabel(seat),
    remaining,
    unusedSquares,
    allPieces,
    allPiecesBonus,
    monominoBonus,
    bonus: allPiecesBonus + monominoBonus,
    score: -unusedSquares + allPiecesBonus + monominoBonus,
    lastPiece,
  };
}

function settle(state, reason) {
  const scores = Object.fromEntries(SEATS.map((seat) => [seat, scoreSeat(state, seat)]));
  const best = Math.max(...SEATS.map((seat) => scores[seat].score));
  const winners = SEATS.filter((seat) => scores[seat].score === best);
  const winnerSeat = winners.length === 1 ? winners[0] : null;
  state.scores = scores;
  state.outcome = {
    type: winnerSeat ? 'win' : 'draw',
    winnerSeat,
    winnerLabel: winnerSeat ? seatLabel(winnerSeat) : null,
    reason,
    scores,
    lastAction: state.lastAction,
    move: state.lastAction?.anchor ?? null,
    pieceId: state.lastAction?.pieceId ?? null,
  };
  state.turn = null;
}

export function getOutcome(state) {
  return state.outcome;
}

export function getAutomaticAction(state) {
  if (state.outcome || !state.turn) return null;
  const legal = allLegalActions(state, state.turn);
  if (legal.length) return null;
  return { type: 'pass', reason: 'no_legal_move' };
}

function boardAsText(state) {
  const lines = [];
  lines.push(`    ${COLUMNS.split('').join(' ')}`);
  for (let row = 0; row < SIZE; row += 1) {
    const cells = Array.from({ length: SIZE }, (_, col) => {
      const value = state.board[row][col];
      return value === FIRST_SEAT ? 'G' : value === SECOND_SEAT ? 'B' : '.';
    });
    lines.push(`${String(row + 1).padStart(2, ' ')}  ${cells.join(' ')}`);
  }
  lines.push('G = 红方，B = 蓝方，. = 空；列 A–N，行 1–14。');
  return lines.join('\n');
}

function inventoryText(state, seat) {
  return state.inventories[seat].map((pieceId) => {
    const piece = PIECE_MAP.get(pieceId);
    return `${pieceId}(${piece?.size ?? '?'}格)`;
  }).join('、') || '无';
}

export function describeForModel({ state, seatId, mode = 'pure', allowSpeech = false }) {
  const speech = allowSpeech ? ',"say":"可选的一句公开想法"' : '';
  const responseFormat = mode === 'assisted'
    ? `{"candidate":"c1"${speech}}`
    : `{"pieceId":"P5-09","orientation":2,"anchor":"E5"${speech}}`;
  const remainingIds = new Set([...state.inventories.gold, ...state.inventories.blue]);
  const pieceShapes = PIECES.filter((piece) => remainingIds.has(piece.id)).map((piece) => ({
    id: piece.id,
    name: piece.name,
    size: piece.size,
    cells: piece.cells.map(([row, col]) => [row, col]),
    orientations: piece.orientations.map((orientation) => ({
      index: orientation.index,
      mirrored: orientation.mirrored,
      cells: orientation.cells.map(([row, col]) => [row, col]),
    })),
  }));
  return {
    gameName: '角斗士棋：双人对决',
    rulesVersion: '1.0.0',
    seatId,
    seatLabel: seatLabel(seatId),
    turn: state.turn,
    boardText: boardAsText(state),
    pieces: pieceShapes,
    coordinateSystem: {
      columns: 'A–N，从左到右',
      rows: '1–14，从上到下',
      anchor: '锚点取棋子朝向包围盒的左上格；棋子所有格相对锚点展开。',
      example: 'E5',
    },
    startPoints: START_POINTS.map((start) => ({ ...start })),
    chosenStart: state.chosenStart == null ? null : START_POINTS[state.chosenStart],
    firstMoves: { ...state.firstMoves },
    remaining: {
      gold: inventoryText(state, 'gold'),
      blue: inventoryText(state, 'blue'),
    },
    yourRemaining: inventoryText(state, seatId),
    lastMove: state.lastAction,
    responseFormat,
    rulesText: [
      '14×14 棋盘，双方各 21 块标准 Blokus 棋子。',
      '先手第一块必须覆盖 E5 或 J10；后手第一块必须覆盖另一个起始点。',
      '第一块之后，每块至少与己方已放棋子的一个角接触；任意格不得与己方棋子边接触。',
      '异色棋子可以边接触；不能重叠、越界或重复使用棋子。',
      '无合法摆法时系统跳过；双方都无法摆法或一方放完全部棋子时结算。',
      '未放方格每格 -1；全部放完 +15；最后一块是单格棋再 +5。',
    ].join('\n'),
    ...(mode === 'assisted' ? { assistedMode: true } : { assistedMode: false }),
  };
}

export function parseModelMove(content) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: '模型返回了空内容。' };
  let candidate = text;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) candidate = fenced[1].trim();
  else if (text.includes('```')) return { ok: false, error: '输出包含不完整的 Markdown 代码围栏。' };
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
    return { ok: false, error: '一次只能提交一个动作，不能返回动作数组。' };
  }
  if (parsed.say != null && typeof parsed.say !== 'string') {
    return { ok: false, error: 'say 必须是字符串。' };
  }
  const say = String(parsed.say ?? '').trim().slice(0, 120);
  const candidateId = parsed.candidate ?? parsed.candidateId;
  if (candidateId != null) {
    if (typeof candidateId !== 'string' || !/^c[1-9]\d*$/.test(candidateId.trim())) {
      return { ok: false, error: 'candidate 必须形如 c1、c2。' };
    }
    if (parsed.pieceId != null || parsed.orientation != null || parsed.anchor != null
      || parsed.row != null || parsed.col != null) {
      return { ok: false, error: 'candidate 不能和完整棋子字段同时出现。' };
    }
    return {
      ok: true,
      action: { type: 'place', candidateId: candidateId.trim() },
      say,
    };
  }
  if (typeof parsed.pieceId !== 'string' || !getPiece(parsed.pieceId)) {
    return { ok: false, error: '缺少有效的 pieceId，或应返回 candidate ID。' };
  }
  if (!Number.isInteger(parsed.orientation) && !/^\d+$/.test(String(parsed.orientation ?? ''))) {
    return { ok: false, error: 'orientation 必须是从 0 开始的整数。' };
  }
  const orientation = Number(parsed.orientation);
  let anchor = parsed.anchor;
  if (anchor == null && Number.isInteger(parsed.row) && Number.isInteger(parsed.col)) {
    anchor = cellLabel(parsed.row, parsed.col);
  }
  const parsedAnchor = parseAnchor(anchor);
  if (!parsedAnchor.ok) return { ok: false, error: parsedAnchor.message };
  return {
    ok: true,
    action: {
      type: 'place',
      pieceId: parsed.pieceId,
      orientation,
      anchor: parsedAnchor.anchor,
    },
    say,
  };
}

export function describeAction(action) {
  if (!action || typeof action !== 'object') return '—';
  if (action.type === 'pass') {
    return action.reason === 'no_legal_move' ? '系统跳过（无合法摆法）' : `跳过（${action.reason ?? '无合法摆法'}）`;
  }
  if (!action.pieceId) return action.candidateId ? `候选 ${action.candidateId}` : '—';
  const anchor = action.anchor ?? cellLabel(action.row, action.col) ?? '—';
  return `${action.pieceId} → ${anchor}（朝向 ${action.orientation ?? '?'}）`;
}

export function autoCommentCandidates({ state, action }) {
  if (state.outcome) {
    const scoreText = SEATS.map((seat) => {
      const item = state.scores?.[seat];
      return item ? `${item.label} ${item.score} 分` : '';
    }).filter(Boolean).join('；');
    return [{
      key: `end:${state.outcome.type}:${state.actionCount}`,
      type: state.outcome.type === 'draw' ? 'game_draw' : 'game_end',
      priority: 100,
      summary: state.outcome.type === 'draw'
        ? `双方同分，和棋。${scoreText}`
        : `${state.outcome.winnerLabel}获胜。${scoreText}`,
      details: { outcome: state.outcome, scores: state.scores },
    }];
  }
  if (action?.action?.type === 'pass') {
    return [{
      key: `pass:${action.seat}:${state.actionCount}`,
      type: 'blokus_pass',
      priority: 45,
      summary: `${seatLabel(action.seat)}没有合法摆法，系统跳过。`,
      details: { seat: action.seat, reason: action.action.reason ?? 'no_legal_move' },
    }];
  }
  if (action?.action?.type === 'place') {
    const piece = getPiece(action.action.pieceId);
    return [{
      key: `place:${action.seat}:${state.actionCount}:${action.action.pieceId}:${action.action.anchor}`,
      type: 'blokus_place',
      priority: 50,
      summary: `${seatLabel(action.seat)}放下 ${piece?.name ?? action.action.pieceId}，锚点 ${action.action.anchor}，占 ${piece?.size ?? '?'} 格。`,
      details: {
        seat: action.seat,
        pieceId: action.action.pieceId,
        anchor: action.action.anchor,
        cells: action.action.cells ?? [],
      },
    }];
  }
  return [];
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText ?? 'blokus-duo')) {
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

function futureCorners(state, seat, action) {
  const next = cloneStateShell(state);
  for (const [row, col] of action.cells) next.board[row][col] = seat;
  let count = 0;
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (next.board[row][col] != null) continue;
      let ownDiagonal = false;
      for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && next.board[nr][nc] === seat) {
          ownDiagonal = true;
          break;
        }
      }
      if (ownDiagonal) count += 1;
    }
  }
  return count;
}

export function chooseBotAction({ state, seat, seed }) {
  if (state.outcome) return { type: 'pass', reason: 'game_over' };
  const legal = allLegalActions(state, seat);
  if (!legal.length) return { type: 'pass', reason: 'no_legal_move' };
  const random = seededRandom(`${seed}:${state.actionCount}:${seat}`);
  // Bounded deterministic evaluation. Large openings stay fast while keeping
  // all legal choices in contention through the size/space score.
  const ranked = legal.slice(0, 6000).map((action) => ({
    action,
    score: pieceSize(action.pieceId) * 100
      + futureCorners(state, seat, action) * 4
      + (14 - (Math.abs(action.row - 6.5) + Math.abs(action.col - 6.5)))
      + random() * 8,
  })).sort((a, b) => b.score - a.score
    || a.action.pieceId.localeCompare(b.action.pieceId)
    || a.action.orientation - b.action.orientation
    || a.action.row - b.action.row
    || a.action.col - b.action.col);
  return ranked[0].action;
}

export function getPublicState(state) {
  return {
    gameId: 'blokus-duo',
    size: SIZE,
    columns: COLUMNS,
    rows: Array.from({ length: SIZE }, (_, index) => index + 1),
    coordinateSystem: {
      columns: 'A–N，从左到右',
      rows: '1–14，从上到下',
      anchor: '锚点取棋子朝向包围盒的左上格。',
    },
    board: state.board.map((row) => row.slice()),
    turn: state.turn,
    actionCount: state.actionCount,
    startPoints: START_POINTS.map((start) => ({ ...start })),
    chosenStart: state.chosenStart,
    firstMoves: { ...state.firstMoves },
    passed: { ...state.passed },
    inventories: {
      gold: [...state.inventories.gold],
      blue: [...state.inventories.blue],
    },
    lastPlacedPiece: { ...state.lastPlacedPiece },
    lastAction: state.lastAction,
    outcome: state.outcome,
    scores: state.scores,
    pieces: pieceCatalog(),
  };
}

export function getSeatView(state, seatId) {
  return { ...getPublicState(state), yourSeat: seatId };
}

export function boardText(state) {
  return boardAsText(state);
}

export { PIECES, PIECE_MAP, getPiece, orientationFor, pieceSize };
