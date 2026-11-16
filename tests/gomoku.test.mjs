import test from 'node:test';
import assert from 'node:assert/strict';
import gomokuGame from '../packages/games/gomoku/index.mjs';
import {
  SIZE,
  parseCoordinate,
  createEmptyBoard,
  findWinningLine,
  isBoardFull,
  boardAsText,
} from '../packages/games/gomoku/rules.mjs';

function play(game, moves) {
  let state = game.createInitialState({ seed: 'test' });
  for (const move of moves) {
    const [seat, coordinate] = move.split(':');
    const validation = game.validateAction(state, seat, { type: 'place', move: coordinate });
    assert.equal(validation.ok, true, `${seat} ${coordinate}: ${validation.message}`);
    state = game.applyAction(state, seat, { type: 'place', move: coordinate }).state;
  }
  return state;
}

function alternating(blackMoves, whiteMoves) {
  const moves = [];
  for (let index = 0; index < blackMoves.length; index += 1) {
    moves.push(`black:${blackMoves[index]}`);
    // 黑方最后一手通常是制胜手，不再追加白方落子，否则会按规则被拒绝。
    if (index < blackMoves.length - 1 && whiteMoves[index]) {
      moves.push(`white:${whiteMoves[index]}`);
    }
  }
  return moves;
}

test('坐标约定 H8 是中央天元，A1/O15 是对角边界', () => {
  assert.deepEqual(parseCoordinate('H8'), { ok: true, move: 'H8', row: 7, col: 7 });
  assert.deepEqual(parseCoordinate(' a1 '), { ok: true, move: 'A1', row: 14, col: 0 });
  assert.deepEqual(parseCoordinate('O15'), { ok: true, move: 'O15', row: 0, col: 14 });
  assert.equal(parseCoordinate('P8').code, 'out_of_range');
  assert.equal(parseCoordinate('H0').code, 'out_of_range');
  assert.equal(parseCoordinate('嗨8').code, 'invalid_coordinate');
});

test('黑先、白后；非当前玩家不能落子', () => {
  const state = gomokuGame.createInitialState();
  assert.equal(state.turn, 'black');
  const wrong = gomokuGame.validateAction(state, 'white', { type: 'place', move: 'H8' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'wrong_turn');
  const okay = gomokuGame.validateAction(state, 'black', { type: 'place', move: 'H8' });
  assert.equal(okay.ok, true);
  assert.equal(gomokuGame.validateAction(state, 'nobody', { type: 'place', move: 'H8' }).code, 'unknown_seat');
});

test('重复落点被拒绝且不改变棋盘', () => {
  let state = play(gomokuGame, ['black:H8', 'white:A1']);
  const before = JSON.stringify(state.board);
  const duplicate = gomokuGame.validateAction(state, 'black', { type: 'place', move: 'A1' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'occupied');
  assert.equal(JSON.stringify(state.board), before);
  const h8 = gomokuGame.validateAction(state, 'black', { type: 'place', move: 'H8' });
  assert.equal(h8.code, 'occupied');
});

test('越界、格式错误和未知动作都不会落子', () => {
  let state = gomokuGame.createInitialState();
  for (const move of ['P8', 'A0', 'A16', 'ZZ', '', 'H 8']) {
    const result = gomokuGame.validateAction(state, 'black', { type: 'place', move });
    assert.equal(result.ok, false, move);
  }
  assert.equal(gomokuGame.validateAction(state, 'black', { type: 'delete', move: 'H8' }).code, 'invalid_action');
  assert.equal(state.moveCount, 0);
});

test('横向五连获胜并标出胜利连线', () => {
  const state = play(
    gomokuGame,
    alternating(['A1', 'B1', 'C1', 'D1', 'E1'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  assert.equal(state.outcome.type, 'win');
  assert.equal(state.outcome.winnerSeat, 'black');
  assert.equal(state.outcome.direction, 'horizontal');
  assert.equal(state.outcome.line.length, 5);
  assert.equal(state.turn, null);
});

test('纵向五连获胜', () => {
  const state = play(
    gomokuGame,
    alternating(['A1', 'A2', 'A3', 'A4', 'A5'], ['O15', 'O13', 'O11', 'O9', 'O7']),
  );
  assert.equal(state.outcome.type, 'win');
  assert.equal(state.outcome.direction, 'vertical');
});

test('斜向五连获胜（两种斜线）', () => {
  const diagonalDown = play(
    gomokuGame,
    alternating(['A5', 'B4', 'C3', 'D2', 'E1'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  assert.equal(diagonalDown.outcome.winnerSeat, 'black');
  assert.equal(diagonalDown.outcome.direction, 'diagonal-down');

  const diagonalUp = play(
    gomokuGame,
    alternating(['A1', 'B2', 'C3', 'D4', 'E5'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  assert.equal(diagonalUp.outcome.winnerSeat, 'black');
  assert.equal(diagonalUp.outcome.direction, 'diagonal-up');
});

test('长于五子（六连）同样获胜，胜利连线包含六子', () => {
  const state = play(
    gomokuGame,
    // 前五子中间留空，避免在第六手前已经形成五连；最后一手补空形成六连。
    alternating(['A1', 'B1', 'C1', 'E1', 'F1', 'D1'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  assert.equal(state.outcome.type, 'win');
  assert.equal(state.outcome.length, 6);
  assert.equal(state.winningLine.length, 6);
});

test('终局后任何一方都不能继续落子', () => {
  let state = play(
    gomokuGame,
    alternating(['A1', 'B1', 'C1', 'D1', 'E1'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  assert.equal(state.outcome.type, 'win');
  const moveCount = state.moveCount;
  const result = gomokuGame.validateAction(state, 'white', { type: 'place', move: 'H8' });
  assert.equal(result.code, 'game_over');
  assert.equal(state.moveCount, moveCount);
  assert.equal(gomokuGame.legalActions(state, 'white').length, 0);
});

function makeNoFivePattern() {
  // 4×4 周期图案，在 15×15 的横、竖和两个斜线方向均不存在五连。
  const tile = ['BBWB', 'BWBW', 'BWBB', 'WBWW'];
  const board = createEmptyBoard();
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      board[row][col] = tile[row % 4][col % 4] === 'B' ? 'black' : 'white';
    }
  }
  return board;
}

test('满盘且无五连时和棋', () => {
  const fullBoard = makeNoFivePattern();
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      assert.equal(
        findWinningLine(fullBoard, row, col, fullBoard[row][col]),
        null,
        `预置棋盘在 ${row},${col} 已经有五连`,
      );
    }
  }
  assert.equal(isBoardFull(fullBoard), true);
  const board = fullBoard.map((row) => row.slice());
  const empty = { row: 14, col: 14 };
  const lastSeat = board[empty.row][empty.col];
  board[empty.row][empty.col] = null;
  const state = {
    size: SIZE,
    board,
    turn: lastSeat,
    moveCount: SIZE * SIZE - 1,
    lastMove: null,
    outcome: null,
    winningLine: null,
  };
  const applied = gomokuGame.applyAction(state, lastSeat, { type: 'place', move: 'O1' });
  assert.equal(isBoardFull(applied.state.board), true);
  assert.deepEqual(applied.state.outcome, { type: 'draw', winnerSeat: null, winnerLabel: null });
  assert.equal(boardAsText(applied.state.board).split('\n').length, SIZE + 1);
});

test('模型 JSON 解析宽容但会校验非法坐标', () => {
  assert.deepEqual(gomokuGame.parseModelMove('{"move":"h8","say":"我先占中间。"}'), {
    ok: true,
    action: { type: 'place', move: 'H8' },
    say: '我先占中间。',
  });
  assert.equal(
    gomokuGame.parseModelMove('```json\n{"move":"A1"}\n```').action.move,
    'A1',
  );
  assert.deepEqual(gomokuGame.parseModelMove('我觉得下这里：{"move":"O15"} 比较好'), {
    ok: true,
    action: { type: 'place', move: 'O15' },
    say: '',
  });
  assert.equal(gomokuGame.parseModelMove('{"move":"Z99"}').ok, false);
  assert.equal(gomokuGame.parseModelMove('我不想下').ok, false);
  assert.equal(gomokuGame.parseModelMove('{"move":"H8","say":"' + '长'.repeat(300) + '"}').say.length, 120);
});

test('关键事件包含成五威胁和终局，且 key 可去重', () => {
  const state = play(gomokuGame, ['black:A1', 'white:O15', 'black:B1', 'white:O13', 'black:C1', 'white:O11', 'black:D1']);
  const highlights = gomokuGame.autoCommentCandidates({ state, action: { seat: 'black', move: 'D1' } });
  assert.ok(highlights.some((item) => item.type === 'threat' && item.details.seat === 'black'));
  assert.equal(new Set(highlights.map((item) => item.key)).size, highlights.length);

  const gameOver = play(
    gomokuGame,
    alternating(['A1', 'B1', 'C1', 'D1', 'E1'], ['A15', 'C15', 'E15', 'G15', 'I15']),
  );
  const end = gomokuGame.autoCommentCandidates({ state: gameOver, action: { seat: 'black', move: 'E1' } });
  assert.equal(end.length, 1);
  assert.equal(end[0].type, 'game_end');
  assert.equal(end[0].priority, 100);
});
