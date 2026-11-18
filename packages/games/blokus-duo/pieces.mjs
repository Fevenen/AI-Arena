/**
 * Standard 21-piece Blokus Duo set: exactly one free polyomino of each size
 * 1..5. IDs are stable and never depend on the player color or board state.
 *
 * Cell coordinates are [row, column], zero-based, row 0 at the top.
 * An orientation is normalized so its top-left occupied cell is [0, 0].
 * Every action uses the top-left corner of the orientation as its anchor.
 */
const DEFINITIONS = [
  { id: 'P1-01', name: '单格', size: 1, cells: [[0, 0]] },
  { id: 'P2-01', name: '二连', size: 2, cells: [[0, 0], [0, 1]] },

  { id: 'P3-01', name: '三连', size: 3, cells: [[0, 0], [0, 1], [0, 2]] },
  { id: 'P3-02', name: '三格 L', size: 3, cells: [[0, 0], [0, 1], [1, 0]] },

  { id: 'P4-01', name: '四连', size: 4, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 'P4-02', name: '四格 L', size: 4, cells: [[0, 0], [0, 1], [0, 2], [1, 0]] },
  { id: 'P4-03', name: '四格 T', size: 4, cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },
  { id: 'P4-04', name: '四方块', size: 4, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { id: 'P4-05', name: '四格 S', size: 4, cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },

  { id: 'P5-01', name: '五连', size: 5, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  { id: 'P5-02', name: '五格 L', size: 5, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0]] },
  { id: 'P5-03', name: '五格 Y', size: 5, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1]] },
  { id: 'P5-04', name: '五格 P', size: 5, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1]] },
  { id: 'P5-05', name: '五格 U', size: 5, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 2]] },
  { id: 'P5-06', name: '五格 N', size: 5, cells: [[0, 0], [0, 1], [0, 2], [1, 2], [1, 3]] },
  { id: 'P5-07', name: '五格 V', size: 5, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0]] },
  { id: 'P5-08', name: '五格 T', size: 5, cells: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]] },
  { id: 'P5-09', name: '五格 F', size: 5, cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 1]] },
  { id: 'P5-10', name: '五格 W', size: 5, cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]] },
  { id: 'P5-11', name: '五格 Z', size: 5, cells: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]] },
  { id: 'P5-12', name: '五格 X', size: 5, cells: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]] },
];

const BASE_PIECES = DEFINITIONS.map((piece) => ({
  ...piece,
  cells: piece.cells.map(([row, col]) => [row, col]),
}));

export class PieceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PieceError';
    this.code = code;
  }
}

export function normalizeCells(cells) {
  const minRow = Math.min(...cells.map(([row]) => row));
  const minCol = Math.min(...cells.map(([, col]) => col));
  return cells
    .map(([row, col]) => [row - minRow, col - minCol])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function rotateCells(cells) {
  return normalizeCells(cells.map(([row, col]) => [col, -row]));
}

export function mirrorCells(cells) {
  return normalizeCells(cells.map(([row, col]) => [row, -col]));
}

export function cellsKey(cells) {
  return cells.map(([row, col]) => `${row},${col}`).join(';');
}

function buildOrientations(baseCells) {
  const seen = new Set();
  const result = [];
  for (const mirrored of [false, true]) {
    let cells = normalizeCells(mirrored ? mirrorCells(baseCells) : baseCells);
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const normalized = normalizeCells(cells);
      const key = cellsKey(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          index: result.length,
          rotation,
          mirrored,
          cells: normalized.map(([row, col]) => [row, col]),
        });
      }
      cells = rotateCells(normalized);
    }
  }
  return result;
}

export const PIECES = Object.freeze(BASE_PIECES.map((piece) => {
  const orientations = buildOrientations(piece.cells);
  const height = Math.max(...piece.cells.map(([row]) => row)) + 1;
  const width = Math.max(...piece.cells.map(([, col]) => col)) + 1;
  return Object.freeze({
    ...piece,
    cells: Object.freeze(piece.cells.map(([row, col]) => Object.freeze([row, col]))),
    width,
    height,
    orientations: Object.freeze(orientations.map((orientation) => Object.freeze({
      ...orientation,
      cells: Object.freeze(orientation.cells.map(([row, col]) => Object.freeze([row, col]))),
    }))),
  });
}));

export const PIECE_MAP = new Map(PIECES.map((piece) => [piece.id, piece]));

export function getPiece(pieceId) {
  return PIECE_MAP.get(String(pieceId ?? '')) ?? null;
}

export function requirePiece(pieceId) {
  const piece = getPiece(pieceId);
  if (!piece) throw new PieceError('unknown_piece', `未知棋子：${pieceId}`);
  return piece;
}

export function orientationFor(pieceId, orientationIndex) {
  const piece = requirePiece(pieceId);
  const index = Number(orientationIndex);
  if (!Number.isInteger(index) || index < 0 || index >= piece.orientations.length) {
    throw new PieceError(
      'unknown_orientation',
      `${piece.name} 没有朝向 ${orientationIndex}；可用朝向为 0–${piece.orientations.length - 1}。`,
    );
  }
  return piece.orientations[index];
}

export function rotatedOrientation(pieceId, orientationIndex, direction = 1) {
  const piece = requirePiece(pieceId);
  const current = orientationFor(pieceId, orientationIndex);
  const group = piece.orientations.filter((orientation) => orientation.mirrored === current.mirrored);
  const position = group.findIndex((orientation) => orientation.index === current.index);
  const next = group[(position + (direction >= 0 ? 1 : group.length - 1)) % group.length];
  return next;
}

export function flippedOrientation(pieceId, orientationIndex) {
  const piece = requirePiece(pieceId);
  const current = orientationFor(pieceId, orientationIndex);
  const candidates = piece.orientations.filter((orientation) => orientation.mirrored !== current.mirrored);
  if (!candidates.length) return current;
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate.rotation - current.rotation) < Math.abs(best.rotation - current.rotation)
      ? candidate : best
  ), candidates[0]);
}

export function orientationCells(pieceId, orientationIndex) {
  return orientationFor(pieceId, orientationIndex).cells;
}

/** Public, JSON-safe catalog. It contains no hidden state. */
export function pieceCatalog() {
  return PIECES.map((piece) => ({
    id: piece.id,
    name: piece.name,
    size: piece.size,
    width: piece.width,
    height: piece.height,
    cells: piece.cells.map(([row, col]) => [row, col]),
    orientations: piece.orientations.map((orientation) => ({
      index: orientation.index,
      rotation: orientation.rotation,
      mirrored: orientation.mirrored,
      cells: orientation.cells.map(([row, col]) => [row, col]),
    })),
  }));
}

export function pieceSize(pieceId) {
  return getPiece(pieceId)?.size ?? 0;
}
