import { RuleError } from '../../core/errors.mjs';

export const SIZE = 15;
export const COLUMNS = 'ABCDEFGHIJKLMNO';
export const ROWS_FROM_TOP = Array.from({ length: SIZE }, (_, index) => SIZE - index);
export const DIRECTIONS = [
  { row: 0, col: 1, name: 'horizontal' },
  { row: 1, col: 0, name: 'vertical' },
  { row: 1, col: 1, name: 'diagonal-down' },
  { row: 1, col: -1, name: 'diagonal-up' },
];

export function cellToCoord(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
    throw new RuleError('out_of_range', '坐标超出 15×15 棋盘');
  }
  return `${COLUMNS[col]}${SIZE - row}`;
}

/**
 * 返回解析结果而不是抛异常，方便统一映射成面向用户的校验错误。
 * 坐标约定：列 A-O 从左到右，行 15 到 1 从上到下，H8 为天元。
 */
export function parseCoordinate(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_coordinate', message: '落子坐标必须是字符串，例如 H8。' };
  }
  const normalized = value.trim().toUpperCase();
  const match = /^([A-Z])(\d{1,2})$/.exec(normalized);
  if (!match) {
    return { ok: false, code: 'invalid_coordinate', message: '坐标格式应为 A1 到 O15，例如 H8。' };
  }
  const col = match[1].charCodeAt(0) - 65;
  const rowNumber = Number(match[2]);
  const row = SIZE - rowNumber;
  if (col < 0 || col >= SIZE || rowNumber < 1 || rowNumber > SIZE) {
    return {
      ok: false,
      code: 'out_of_range',
      message: `坐标 ${normalized} 超出 A1-O15 的范围。`,
    };
  }
  return { ok: true, move: `${COLUMNS[col]}${rowNumber}`, row, col };
}

export function createEmptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

export function opposite(seat) {
  if (seat === 'black') return 'white';
  if (seat === 'white') return 'black';
  throw new RuleError('unknown_seat', `未知座位：${seat}`);
}

export function seatLabel(seat) {
  return seat === 'black' ? '黑方' : seat === 'white' ? '白方' : seat;
}

export function lineThrough(board, row, col, direction, seat) {
  const cells = [{ row, col }];
  for (const sign of [-1, 1]) {
    let nextRow = row + direction.row * sign;
    let nextCol = col + direction.col * sign;
    while (
      nextRow >= 0 &&
      nextRow < SIZE &&
      nextCol >= 0 &&
      nextCol < SIZE &&
      board[nextRow][nextCol] === seat
    ) {
      if (sign === 1) cells.push({ row: nextRow, col: nextCol });
      else cells.unshift({ row: nextRow, col: nextCol });
      nextRow += direction.row * sign;
      nextCol += direction.col * sign;
    }
  }
  return cells;
}

export function findWinningLine(board, row, col, seat) {
  let best = null;
  for (const direction of DIRECTIONS) {
    const cells = lineThrough(board, row, col, direction, seat);
    if (cells.length >= 5 && (!best || cells.length > best.cells.length)) {
      best = { direction: direction.name, cells };
    }
  }
  return best;
}

export function wouldWin(board, row, col, seat) {
  if (board[row][col] != null) return false;
  board[row][col] = seat;
  let won = false;
  for (const direction of DIRECTIONS) {
    const count =
      1 +
      countDirection(board, row, col, direction.row, direction.col, seat) +
      countDirection(board, row, col, -direction.row, -direction.col, seat);
    if (count >= 5) {
      won = true;
      break;
    }
  }
  board[row][col] = null;
  return won;
}

function countDirection(board, row, col, deltaRow, deltaCol, seat) {
  let count = 0;
  let r = row + deltaRow;
  let c = col + deltaCol;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === seat) {
    count += 1;
    r += deltaRow;
    c += deltaCol;
  }
  return count;
}

export function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell != null));
}

export function boardAsText(board) {
  const lines = [`    ${COLUMNS.split('').join(' ')}`];
  for (let row = 0; row < SIZE; row += 1) {
    const cells = board[row].map((cell) => (cell === 'black' ? 'B' : cell === 'white' ? 'W' : '.'));
    lines.push(`${String(SIZE - row).padStart(2, ' ')}  ${cells.join(' ')}`);
  }
  return lines.join('\n');
}
