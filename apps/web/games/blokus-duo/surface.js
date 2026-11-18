/**
 * Blokus Duo presentation and local preview.
 *
 * The preview is deliberately advisory: the server rule engine remains the
 * authority for every submitted action. Keeping the preview here lets the
 * board show the exact covered cells before the confirmation click without
 * adding a second mutation path.
 */

const COLUMNS = 'ABCDEFGHIJKLMN';
const UI = new Map();

function cellName(row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col)
    || row < 0 || row >= 14 || col < 0 || col >= 14) return null;
  return `${COLUMNS[col]}${row + 1}`;
}

function getUi(matchId, readonly = false) {
  const key = `${matchId}:${readonly ? 'readonly' : 'live'}`;
  if (!UI.has(key)) {
    UI.set(key, {
      pieceId: null,
      orientation: 0,
      anchor: null,
      error: '',
      actionCount: null,
    });
  }
  return UI.get(key);
}

function pieceOf(view, pieceId) {
  return (view.pieces ?? []).find((piece) => piece.id === pieceId) ?? null;
}

function seatLabel(match, seatId) {
  if (seatId === 'gold') return '红方';
  const seat = match?.seats?.[seatId];
  return seat?.colorName ?? seat?.name ?? match?.game?.seats?.find((item) => item.id === seatId)?.name ?? '席位';
}

function seatColor(match, seatId, fallback) {
  const def = match?.game?.seats?.find((item) => item.id === seatId);
  return fallback?.(def) ?? (seatId === 'gold' || seatId === 'red' ? '#d95b5b' : seatId === 'blue' ? '#759bc7' : '#7e8d96');
}

function formatAction(match, view, action) {
  if (!action) return '—';
  if (action.type === 'pass') {
    return `${seatLabel(match, view.lastAction?.seat)} 无合法摆法，系统跳过`;
  }
  const piece = pieceOf(view, action.pieceId);
  return `${seatLabel(match, view.lastAction?.seat)} 放置 ${piece?.name ?? action.pieceId}（${action.anchor}）`;
}

function miniPiece(piece) {
  if (!piece) return '';
  const cells = piece.cells ?? [];
  const width = piece.width ?? Math.max(...cells.map(([, col]) => col)) + 1;
  const height = piece.height ?? Math.max(...cells.map(([row]) => row)) + 1;
  return `<span class="blokus-mini" style="--cols:${width};--rows:${height}" aria-hidden="true">${cells.map(([row, col]) => `<i style="grid-column:${col + 1};grid-row:${row + 1}"></i>`).join('')}</span>`;
}

function orientationFor(piece, index) {
  return piece?.orientations?.[index] ?? piece?.orientations?.[0] ?? null;
}

function previewPlacement(view, seat, pieceId, orientationIndex, anchor) {
  const piece = pieceOf(view, pieceId);
  if (!piece) return { valid: false, cells: [], error: '请先从托盘选择一块棋子。' };
  if (!(view.inventories?.[seat] ?? []).includes(pieceId)) {
    return { valid: false, cells: [], error: '这块棋子已经用过了。' };
  }
  const orientation = orientationFor(piece, orientationIndex);
  if (!orientation) return { valid: false, cells: [], error: '这个朝向不可用。' };
  if (!anchor) return { valid: false, cells: [], error: '点击棋盘选择锚点；锚点是棋子左上角。' };
  const cells = orientation.cells.map(([row, col]) => [anchor.row + row, anchor.col + col]);
  if (cells.some(([row, col]) => row < 0 || row >= 14 || col < 0 || col >= 14)) {
    return { valid: false, cells, error: '棋子会超出棋盘边界。' };
  }
  if (cells.some(([row, col]) => view.board?.[row]?.[col] != null)) {
    return { valid: false, cells, error: '棋子覆盖了已有棋子。' };
  }
  const starts = (view.startPoints ?? []).filter((start) => cells.some(([row, col]) => row === start.row && col === start.col));
  if (!view.firstMoves?.[seat]) {
    if (seat === 'gold') {
      if (starts.length !== 1) return { valid: false, cells, error: '先手第一块必须覆盖 E5 或 J10 其中一个起始点。' };
    } else {
      if (view.chosenStart == null) return { valid: false, cells, error: '先手还没有选择起始点。' };
      const required = (view.startPoints ?? [])[1 - view.chosenStart];
      if (!starts.some((start) => start.index === required?.index)) {
        return { valid: false, cells, error: `后手第一块必须覆盖另一个起始点 ${required?.label ?? ''}。` };
      }
    }
  }
  let corner = false;
  for (const [row, col] of cells) {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= 14 || nc < 0 || nc >= 14) continue;
      if (view.board[nr][nc] === seat) {
        return {
          valid: false,
          cells,
          error: `新棋块贴到了己方棋边：${cellName(row, col)} 与 ${cellName(nr, nc)}。`,
        };
      }
    }
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < 14 && nc >= 0 && nc < 14 && view.board[nr][nc] === seat) corner = true;
    }
  }
  if (view.firstMoves?.[seat] && !corner) {
    return { valid: false, cells, error: '新棋块必须至少与己方已有棋子角接触。' };
  }
  return {
    valid: true,
    cells,
    error: '',
    action: {
      type: 'place',
      pieceId,
      orientation: orientation.index,
      anchor: cellName(anchor.row, anchor.col),
    },
  };
}

function scoredRows(match, view, helpers) {
  const scores = view.outcome?.scores ?? view.scores;
  if (!scores) return '';
  const order = match.seatOrder ?? Object.keys(match.seats ?? {});
  return `<div class="blokus-score-list">${order.map((seatId) => {
    const item = scores[seatId];
    if (!item) return '';
    const winner = view.outcome?.winnerSeat === seatId;
    return `<div class="blokus-score-row ${winner ? 'winner' : ''}">
      <span class="blokus-score-seat"><i style="--seat-color:${seatColor(match, seatId)}"></i>${helpers.escapeHtml(seatLabel(match, seatId))}</span>
      <span>未放 ${item.unusedSquares} 格 · 全放奖励 +${item.allPiecesBonus} · 单格收尾 +${item.monominoBonus}</span>
      <strong>${item.score} 分</strong>
    </div>`;
  }).join('')}</div>`;
}

function renderTray(match, view, seat, ui, helpers, myTurn) {
  const remaining = view.inventories?.[seat] ?? [];
  return `<div class="blokus-tray" aria-label="${helpers.escapeAttr(seatLabel(match, seat))}剩余棋子">
    ${remaining.map((pieceId) => {
      const piece = pieceOf(view, pieceId);
      if (!piece) return '';
      return `<button type="button" class="blokus-piece ${ui.pieceId === pieceId ? 'selected' : ''}" data-action="blokus-piece" data-piece="${helpers.escapeAttr(pieceId)}" ${myTurn ? '' : 'disabled'} title="${helpers.escapeAttr(`${piece.name} · ${piece.size} 格`)}" aria-label="${helpers.escapeAttr(`选择${piece.name}，${piece.size}格`)}">
        ${miniPiece(piece)}
        <span>${helpers.escapeHtml(piece.name)}</span>
      </button>`;
    }).join('') || '<span class="blokus-empty">棋子已用尽</span>'}
  </div>`;
}

export function renderBlokusDuoSurface(context, helpers) {
  const { match, view, interactive = false, humanColor = null, title = '对局桌面', replay = false } = context;
  const ui = getUi(match.id, replay);
  if (ui.actionCount !== view.actionCount) {
    ui.pieceId = null;
    ui.orientation = 0;
    ui.anchor = null;
    ui.error = '';
    ui.actionCount = view.actionCount;
  }
  const myTurn = interactive && humanColor && view.turn === humanColor;
  const piece = ui.pieceId ? pieceOf(view, ui.pieceId) : null;
  if (piece && !(view.inventories?.[humanColor] ?? []).includes(ui.pieceId)) {
    ui.pieceId = null;
    ui.orientation = 0;
    ui.anchor = null;
  }
  const selectedOrientation = piece ? orientationFor(piece, ui.orientation) : null;
  const preview = piece && ui.anchor
    ? previewPlacement(view, humanColor, ui.pieceId, ui.orientation, ui.anchor)
    : null;
  const order = match.seatOrder?.length ? match.seatOrder : Object.keys(match.seats ?? {});
  const current = view.turn;
  const last = view.lastAction;
  const lastCells = new Set((last?.cells ?? []).map(([row, col]) => `${row}:${col}`));
  const startMap = new Map((view.startPoints ?? []).map((start) => [`${start.row}:${start.col}`, start]));
  const previewMap = new Map((preview?.cells ?? []).map(([row, col]) => [`${row}:${col}`, preview]));
  const canClickBoard = interactive && myTurn;
  const allPieces = view.pieces ?? [];
  const selectedRemaining = humanColor ? (view.inventories?.[humanColor] ?? []).length : 0;

  const board = `<div class="blokus-board" role="grid" tabindex="0" aria-label="14乘14角斗士棋棋盘">
    ${(view.board ?? []).map((row, rowIndex) => row.map((owner, colIndex) => {
      const key = `${rowIndex}:${colIndex}`;
      const start = startMap.get(key);
      const previewCell = previewMap.get(key);
      const classes = [
        'blokus-cell',
        owner ? `occupied seat-${owner}` : '',
        start ? 'start-point' : '',
        lastCells.has(key) ? 'last-move' : '',
        previewCell ? (preview?.valid ? 'preview-valid' : 'preview-invalid') : '',
      ].filter(Boolean).join(' ');
      const name = cellName(rowIndex, colIndex);
      const ownerName = owner ? seatLabel(match, owner) : '空';
      return `<button type="button" class="${classes}" data-action="${canClickBoard ? 'blokus-cell' : ''}" data-coord="${name}" data-row="${rowIndex}" data-col="${colIndex}" ${canClickBoard ? '' : 'disabled'} style="--seat-color:${owner ? seatColor(match, owner) : 'transparent'}" aria-label="${helpers.escapeAttr(`${name} ${ownerName}${start ? '，起始点' : ''}${previewCell ? '，预览覆盖' : ''}`)}">
        ${owner ? '<span class="blokus-tile"></span>' : ''}
        ${start ? '<span class="blokus-start-mark" title="起始点">✦</span>' : ''}
        ${lastCells.has(key) ? '<span class="blokus-last-mark"></span>' : ''}
        ${previewCell ? '<span class="blokus-preview-mark"></span>' : ''}
      </button>`;
    }).join('')).join('')}
  </div>`;

  const scoreRows = scoredRows(match, view, helpers);
  const finalSummary = view.outcome?.scores
    ? `<div class="blokus-final-summary">${order.map((seatId) => {
      const item = view.outcome.scores[seatId];
      if (!item) return '';
      return `<span class="blokus-final-item ${view.outcome.winnerSeat === seatId ? 'winner' : ''}" style="--seat-color:${seatColor(match, seatId)}">
        <i></i>${helpers.escapeHtml(seatLabel(match, seatId))}
        <strong>${item.score} 分</strong>
        <small>未放 ${item.unusedSquares} 格 · 奖励 +${item.allPiecesBonus + item.monominoBonus}</small>
      </span>`;
    }).join('')}</div>`
    : '';
  const seatHeader = `<div class="blokus-inventories">${order.map((seatId) => {
    const count = (view.inventories?.[seatId] ?? []).length;
    const used = 21 - count;
    return `<div class="blokus-inventory ${current === seatId ? 'active' : ''}" style="--seat-color:${seatColor(match, seatId)}">
      <span class="blokus-inventory-name"><i></i>${helpers.escapeHtml(seatLabel(match, seatId))}</span>
      <strong>${used}<small> / 21 已用</small></strong>
      <span>${count} 块剩余</span>
    </div>`;
  }).join('')}</div>`;

  const currentText = view.outcome
    ? (view.outcome.type === 'draw' ? '同分和棋' : `${seatLabel(match, view.outcome.winnerSeat)}获胜`)
    : `${seatLabel(match, current)}行动`;
  const side = `<aside class="blokus-side">
    <div class="blokus-turn-card">
      <span class="blokus-kicker">CURRENT TURN</span>
      <strong>${helpers.escapeHtml(currentText)}</strong>
      <span>规则辅助/纯模型动作均由服务端统一校验。</span>
    </div>
    ${seatHeader}
    ${view.outcome ? `<section class="blokus-score-card"><div class="blokus-side-title">最终得分</div>${scoreRows}</section>` : ''}
    ${humanColor ? `<section class="blokus-build-card">
      <div class="blokus-side-title">${myTurn ? '轮到你：选一块，再点棋盘锚点' : match.status !== 'playing' ? helpers.escapeHtml(currentText) : `等待 ${helpers.escapeHtml(seatLabel(match, current))} 行动`}</div>
      ${piece ? `<div class="blokus-selected">
        <div>${miniPiece(selectedOrientation)}<span><strong>${helpers.escapeHtml(piece.name)}</strong><small>${piece.id} · ${piece.size} 格 · 朝向 ${ui.orientation}</small></span></div>
        <div class="blokus-build-actions">
          <button class="btn btn-quiet btn-sm" type="button" data-action="blokus-rotate" ${myTurn ? '' : 'disabled'}>旋转</button>
          <button class="btn btn-quiet btn-sm" type="button" data-action="blokus-flip" ${myTurn ? '' : 'disabled'}>翻面</button>
          <button class="btn btn-quiet btn-sm" type="button" data-action="blokus-cancel" ${myTurn ? '' : 'disabled'}>取消</button>
        </div>
      </div>` : `<p class="blokus-hint">从下方托盘选一块棋子。选中后点棋盘上的格子作为左上角锚点。</p>`}
      ${preview ? `<div class="blokus-preview ${preview.valid ? 'ok' : 'bad'}" role="status">${preview.valid ? `可放置：${preview.cells.map(([row, col]) => cellName(row, col)).join('、')}` : preview.error}</div>` : ''}
      ${!preview && ui.error ? `<div class="blokus-preview bad" role="alert">${helpers.escapeHtml(ui.error)}</div>` : ''}
      <div class="blokus-build-footer">
        <span>剩余 ${selectedRemaining} 块</span>
        <button class="btn btn-primary btn-sm" type="button" data-action="blokus-confirm" ${preview?.valid && myTurn ? '' : 'disabled'}>确认摆放</button>
      </div>
      ${renderTray(match, view, humanColor, ui, helpers, myTurn)}
    </section>` : `<section class="blokus-build-card"><div class="blokus-side-title">${replay ? '回放' : '观战'}</div><p class="blokus-hint">${replay ? '历史局面快照' : '双方棋手由 AI 操作。'}</p>${renderTray(match, view, order[0], ui, helpers, false)}</section>`}
  </aside>`;

  return `<section class="board-card blokus-duo-surface">
    <div class="board-card-head blokus-duo-head">
      <div class="board-card-title">${helpers.icon('board', 'icon-sm')} ${helpers.escapeHtml(title)} <span class="chip">14×14 · BLOKUS DUO</span></div>
      <div class="board-last-move">最后一手 ${last ? `<strong>${helpers.escapeHtml(formatAction(match, view, last.action))}</strong>` : '—'}</div>
    </div>
    <div class="blokus-duo-meta">
      <span>列 A–N / 行 1–14</span><span>起始点 <b>E5</b> · <b>J10</b></span><span>同色角接触 / 不同色可贴边</span>${view.outcome ? `<span class="blokus-final-chip">${helpers.escapeHtml(currentText)}</span>` : ''}
    </div>
    ${finalSummary}
    <div class="blokus-duo-layout">
      <div class="blokus-board-wrap">${board}<div class="blokus-board-foot"><span>✦ 起始点 · 圆点格子为已放棋子</span><span>${view.actionCount} 手</span></div></div>
      ${side}
    </div>
  </section>`;
}

function transformOrientation(piece, index, transform) {
  const current = orientationFor(piece, index);
  const cells = current.cells.map(([row, col]) => transform(row, col));
  const top = Math.min(...cells.map(([row]) => row));
  const left = Math.min(...cells.map(([, col]) => col));
  const key = (positions) => positions.map(([row, col]) => [row, col].join(',')).sort().join(';');
  const target = key(cells.map(([row, col]) => [row - top, col - left]));
  return piece.orientations.find((orientation) => key(orientation.cells) === target) ?? current;
}

export function handleBlokusDuoAction(action, element, context) {
  const { match, view, interactive, humanColor } = context;
  if (!interactive || !humanColor || view.turn !== humanColor) return null;
  const ui = getUi(match.id, false);
  const piece = ui.pieceId ? pieceOf(view, ui.pieceId) : null;
  if (action === 'blokus-piece') {
    const pieceId = element.dataset.piece;
    if (!(view.inventories?.[humanColor] ?? []).includes(pieceId)) return { refresh: true };
    ui.pieceId = pieceId;
    ui.orientation = 0;
    ui.anchor = null;
    ui.error = '';
    return { refresh: true };
  }
  if (action === 'blokus-rotate' && piece) {
    ui.orientation = transformOrientation(piece, ui.orientation, (row, col) => [col, -row]).index;
    ui.error = '';
    return { refresh: true };
  }
  if (action === 'blokus-flip' && piece) {
    ui.orientation = transformOrientation(piece, ui.orientation, (row, col) => [row, -col]).index;
    ui.error = '';
    return { refresh: true };
  }
  if (action === 'blokus-cell') {
    if (!ui.pieceId) {
      ui.error = '请先从托盘选择一块棋子，再点击棋盘锚点。';
      return { refresh: true };
    }
    ui.anchor = { row: Number(element.dataset.row), col: Number(element.dataset.col) };
    ui.error = '';
    return { refresh: true };
  }
  if (action === 'blokus-cancel') {
    ui.pieceId = null;
    ui.orientation = 0;
    ui.anchor = null;
    ui.error = '';
    return { refresh: true };
  }
  if (action === 'blokus-confirm') {
    const check = ui.pieceId && ui.anchor
      ? previewPlacement(view, humanColor, ui.pieceId, ui.orientation, ui.anchor)
      : null;
    if (!check?.valid) {
      ui.error = check?.error ?? '还没有可确认的摆放。';
      return { refresh: true };
    }
    return { action: check.action };
  }
  return null;
}
