const appRoot = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');

const state = {
  boot: null,
  route: null,
  models: [],
  dafeiyu: null,
  health: null,
  healthBusy: false,
  healthCheckedAt: 0,
  match: null,
  eventSource: null,
  sseState: null,
  actionBusy: false,
  askBusy: false,
  chatDraft: '',
  chatComposing: false,
  pendingMatchUpdate: false,
  matchShellId: null,
  modelTests: {},
  historyItems: [],
  historyFilters: { player: '', result: '', status: '', game: '', q: '' },
  replay: null,
  replayStep: 0,
  lobby: {
    gameId: 'gomoku',
    setups: {},
    observer: false,
    autoComment: true,
    voice: false,
  },
  modalResolve: null,
  modalOpen: false,
};

const STATUS_LABELS = {
  playing: '进行中',
  paused: '已暂停',
  finished: '已结束',
  aborted: '已中止',
};

const KIND_LABELS = {
  human: '真人',
  model: '模型',
  dafeiyu: '大肥鱼',
  bot: '内置机器人',
};

const RESULT_LABELS = {
  win: '有胜负',
  black_win: '黑方胜',
  white_win: '白方胜',
  draw: '和棋',
  aborted: '已中止',
};

const MOVE_MODE_LABELS = {
  pure: '纯模型',
  assisted: '规则辅助',
};

const ICONS = {
  board: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><circle cx="12" cy="12" r="1.5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M8 5.5 19 12 8 18.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  step: '<path d="M5 5v14l10-7z"/><path d="M19 5v14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.7"/><path d="M20 4v7h-7"/>',
  send: '<path d="M21 3 10 14"/><path d="M21 3 14 21l-4-7-7-4z"/>',
  volume: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  volumeOff: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="m16 9 5 5M21 9l-5 5"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.7-4.6A8.4 8.4 0 1 1 21 11.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  arrowLeft: '<path d="m15 18-6-6 6-6"/>',
  arrowRight: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-1.7 3L16 10H5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6z"/><path d="M12 17v5"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 2h8"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3 4 6v5c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V6z"/><path d="m9 12 2 2 4-4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
};

function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.info}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', '&#10;');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatFullDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function statusClass(status) {
  return ['playing', 'paused', 'finished', 'aborted', 'connected', 'disconnected', 'connecting', 'off'].includes(status)
    ? status
    : 'off';
}

function statusPill(status, label = null) {
  return `<span class="status-pill ${statusClass(status)}"><span class="dot ${status === 'playing' || status === 'connected' ? 'dot-live' : status === 'paused' || status === 'connecting' ? 'dot-warn' : status === 'disconnected' || status === 'aborted' ? 'dot-danger' : ''}"></span>${escapeHtml(label ?? STATUS_LABELS[status] ?? status)}</span>`;
}

function stone(color, extra = '') {
  return `<span class="stone-icon ${color} ${extra}" aria-hidden="true"></span>`;
}

function seatKindChip(seat) {
  return `<span class="seat-kind ${escapeAttr(seat.kind)}">${escapeHtml(KIND_LABELS[seat.kind] ?? seat.kind)}</span>`;
}

class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(pathname, { method = 'GET', body = undefined, headers = {}, signal = undefined } = {}) {
  const options = {
    method,
    headers: { ...headers },
    signal,
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(pathname, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(
      error.message ?? `请求失败（HTTP ${response.status}）`,
      { status: response.status, code: error.code ?? 'request_failed', details: error.details ?? null },
    );
  }
  return data;
}

function toast(message, type = 'info', timeout = 3200) {
  while (toastRoot.children.length >= 3) {
    toastRoot.firstElementChild?.remove();
  }
  const last = toastRoot.lastElementChild;
  if (last && last.dataset.message === `${type}:${message}` && Date.now() - Number(last.dataset.createdAt) < 1200) {
    return;
  }
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.dataset.message = `${type}:${message}`;
  element.dataset.createdAt = String(Date.now());
  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  element.innerHTML = `<span class="toast-icon">${icon(iconName)}</span><span>${escapeHtml(message)}</span>`;
  toastRoot.append(element);
  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 200);
  }, timeout);
}

function showError(error) {
  toast(error?.message ?? String(error), 'error', 5600);
}

function navigate(hash) {
  if (window.location.hash === hash) {
    void handleRoute();
  } else {
    window.location.hash = hash;
  }
}

function routeIs(name, id = null) {
  if (state.route?.name !== name) return false;
  return id == null || state.route.id === id;
}

function isFreshMatch(candidate) {
  if (!candidate) return false;
  if (!state.match || state.match.id !== candidate.id) return true;
  const currentRevision = Number(state.match.revision ?? -1);
  const nextRevision = Number(candidate.revision ?? -1);
  if (Number.isFinite(currentRevision) && Number.isFinite(nextRevision) && currentRevision >= 0 && nextRevision >= 0) {
    return nextRevision >= currentRevision;
  }
  return String(candidate.updatedAt ?? '') >= String(state.match.updatedAt ?? '');
}

function mergeMatchSnapshot(candidate) {
  if (!isFreshMatch(candidate)) return false;
  state.match = candidate;
  return true;
}

function applyLiveMatch(match, matchId) {
  if (!routeIs('match', matchId)) return false;
  if (!mergeMatchSnapshot(match)) return false;
  updateMatchView();
  return true;
}

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/lobby';
  const [pathPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  if (!parts.length) return { name: 'lobby' };
  if (parts[0] === 'lobby') return { name: 'lobby' };
  if (parts[0] === 'models') return { name: 'models' };
  if (parts[0] === 'history') return { name: 'history' };
  if (parts[0] === 'match' && parts[1]) return { name: 'match', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'replay' && parts[1]) return { name: 'replay', id: decodeURIComponent(parts[1]) };
  return { name: 'lobby' };
}

function activeNavFor(route) {
  if (route.name === 'models') return 'models';
  if (route.name === 'history' || route.name === 'replay') return 'history';
  return 'lobby';
}

function renderShell(content, active = 'lobby') {
  const modelsCount = state.models.length;
  appRoot.className = '';
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#/lobby" aria-label="回到桌游库">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-copy">
            <span class="brand-name">AI Arena</span>
            <span class="brand-sub">LOCAL BOARD GAME ARENA</span>
          </span>
        </a>
        <nav class="nav" aria-label="主导航">
          <div class="nav-section-label">本机竞技场</div>
          <a class="nav-link ${active === 'lobby' ? 'active' : ''}" href="#/lobby">
            ${icon('board')}<span>桌游库</span><span class="nav-badge">${(state.boot?.games ?? []).length}</span>
          </a>
          <a class="nav-link ${active === 'history' ? 'active' : ''}" href="#/history">
            ${icon('history')}<span>对局记录</span>
          </a>
          <a class="nav-link ${active === 'models' ? 'active' : ''}" href="#/models">
            ${icon('cpu')}<span>模型管理</span><span class="nav-badge">${modelsCount}</span>
          </a>
        </nav>
        <div class="sidebar-footer">
          <div class="local-status">
            <div class="local-status-row">
              <span class="local-status-strong">本机竞技场</span>
              <span class="chip chip-accent">LOCAL</span>
            </div>
            <div class="local-status-meta">
              ${escapeHtml(state.boot?.app?.url ?? '127.0.0.1')}<br />
              v${escapeHtml(state.boot?.app?.version ?? '0.1.0')} · 单机运行
            </div>
          </div>
          <p class="sidebar-note">选桌游、排座位、开始对局。<br />模型 Key 由后端保管，不进入棋盘。</p>
        </div>
      </aside>
      <div class="main-column">
        <main id="main-content" class="main-content" tabindex="-1">${content}</main>
      </div>
    </div>`;
}

function renderPageHead({ eyebrow, title, subtitle = '', actions = '' }) {
  return `
    <header class="page-head">
      <div>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1 class="page-title">${title}</h1>
        ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
      </div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </header>`;
}

function renderLoading(active = 'lobby', title = '正在加载') {
  renderShell(`
    <div class="page">
      <div class="loading-block">
        <div class="skeleton"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>
      <span class="sr-only">${escapeHtml(title)}</span>
    </div>`, active);
}

function renderFatalError(error) {
  const boot = state.boot;
  const content = `
    <div class="page">
      <div class="error-page">
        <div class="error-box card card-pad">
          <span class="model-badge">${icon('alert')}</span>
          <h1>竞技场暂时没有响应</h1>
          <p>${escapeHtml(error?.message ?? '未知错误')}</p>
          <p class="caption">请确认启动窗口中的 Node 服务仍在运行，然后刷新本页。</p>
          <button class="btn btn-primary mt-12" type="button" data-action="reload-page">${icon('refresh')} 刷新页面</button>
        </div>
      </div>
    </div>`;
  if (!boot) {
    appRoot.className = '';
    appRoot.innerHTML = content;
  } else {
    renderShell(content, activeNavFor(state.route ?? { name: 'lobby' }));
  }
}

function gameDefs() {
  return state.boot?.games ?? [];
}

function gameDef(id = state.lobby.gameId) {
  return gameDefs().find((game) => game.id === id) ?? gameDefs()[0] ?? null;
}

function orderedSeatDefs(game) {
  return [...(game?.seats ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function defaultLobbySeats(game, { quick = false } = {}) {
  const seats = {};
  orderedSeatDefs(game).forEach((def, index) => {
    seats[def.id] = {
      kind: index === 0 ? 'human' : 'bot',
      modelId: '',
      moveMode: 'assisted',
    };
  });
  if (quick) {
    for (const [index, def] of orderedSeatDefs(game).entries()) {
      seats[def.id] = {
        kind: index === 0 ? 'human' : 'bot',
        modelId: '',
        moveMode: 'assisted',
      };
    }
  }
  return seats;
}

function ensureLobbyGame(gameId = state.lobby.gameId, { quick = false, reset = false } = {}) {
  const game = gameDef(gameId);
  if (!game) return null;
  state.lobby.gameId = game.id;
  if (reset || !state.lobby.setups[game.id]) {
    state.lobby.setups[game.id] = quick
      ? defaultLobbySeats(game, { quick: true })
      : state.lobby.setups[game.id] ?? defaultLobbySeats(game);
  }
  if (quick) state.lobby.setups[game.id] = defaultLobbySeats(game, { quick: true });
  // 清理不属于当前游戏的旧座位，避免切换后把错误座位发给后端。
  const valid = new Set(game.seats.map((seat) => seat.id));
  for (const id of Object.keys(state.lobby.setups[game.id])) {
    if (!valid.has(id)) delete state.lobby.setups[game.id][id];
  }
  for (const def of game.seats) {
    if (!state.lobby.setups[game.id][def.id]) {
      state.lobby.setups[game.id][def.id] = { kind: 'bot', modelId: '', moveMode: 'assisted' };
    }
  }
  return game;
}

function lobbySeats() {
  const game = gameDef();
  if (!game) return {};
  ensureLobbyGame(game.id);
  return state.lobby.setups[game.id];
}

function seatDefFor(match, seatId) {
  return match?.game?.seats?.find((seat) => seat.id === seatId)
    ?? orderedSeatDefs(gameDef(match?.gameId)).find((seat) => seat.id === seatId)
    ?? { id: seatId, name: match?.seats?.[seatId]?.colorName ?? seatId, color: null, order: 0 };
}

function modelNameFor(seat) {
  if (seat.kind === 'human') return '你';
  if (seat.kind === 'bot') return '内置机器人';
  if (seat.kind === 'dafeiyu') return '大肥鱼';
  return state.models.find((model) => model.id === seat.modelId)?.name ?? '未选择模型';
}

function modelFor(id) {
  return state.models.find((model) => model.id === id) ?? null;
}

function modelOptions(selected, placeholder = '选择模型配置…') {
  const opts = state.models.map((model) => `
    <option value="${escapeAttr(model.id)}" ${model.id === selected ? 'selected' : ''}>
      ${escapeHtml(model.name)}${model.hasApiKey ? '' : ' · 无 Key'} · ${escapeHtml(model.modelId)}
    </option>`);
  return `<option value="">${escapeHtml(placeholder)}</option>${opts.join('')}`;
}

function seatModeLabel(seat) {
  if (!['model', 'dafeiyu'].includes(seat?.kind)) return '';
  return MOVE_MODE_LABELS[seat.moveMode] ?? '规则辅助';
}

function seatSummary(seat) {
  if (seat.kind === 'human') return '你会在本机桌面上操作。';
  if (seat.kind === 'bot') return '本机启发式落子，不需要 API Key，适合先跑通一整局。';
  if (seat.kind === 'dafeiyu') {
    return `${seatModeLabel(seat)} · 由大肥鱼桌宠的人设、气泡和模型配置控制，竞技场负责校验。`;
  }
  const model = modelFor(seat.modelId);
  if (!model) return '还没有选择模型配置。先到模型管理新增或选择一项。';
  return `${seatModeLabel(seat)} · ${model.providerLabel} · ${model.modelId}${model.hasApiKey ? ' · Key 已设置' : ' · 无 Key'}`;
}

function validateLobby() {
  const errors = [];
  const game = gameDef();
  const seats = lobbySeats();
  const defs = orderedSeatDefs(game);
  const humanSeats = defs.filter((def) => seats[def.id]?.kind === 'human');
  const dafeiyuSeats = defs.filter((def) => seats[def.id]?.kind === 'dafeiyu');
  if (humanSeats.length > 1) {
    errors.push('当前版本一局只容纳一位真人；请把其他席位交给 AI 或大肥鱼。');
  }
  if (dafeiyuSeats.length > 1) {
    errors.push('一局只能有一个大肥鱼棋手席位。');
  }
  for (const def of defs) {
    const seat = seats[def.id];
    if (!seat) {
      errors.push(`${def.name}还没有安排角色。`);
      continue;
    }
    if (seat.kind === 'model') {
      if (!state.models.length) errors.push(`${def.name}选择了模型，但模型管理里还没有配置。`);
      else if (!modelFor(seat.modelId)) errors.push(`${def.name}还没有选择一个有效的模型配置。`);
    }
  }
  return errors;
}

function lobbyHasDafeiyuSeat() {
  return Object.values(lobbySeats()).some((seat) => seat.kind === 'dafeiyu');
}

function lobbyDafeiyuActive() {
  return state.lobby.observer || lobbyHasDafeiyuSeat();
}

function healthBadge() {
  if (!state.health) {
    return `<span class="status-pill off"><span class="dot"></span>未检测</span>`;
  }
  if (state.health.online) {
    return `<span class="status-pill connected"><span class="dot dot-live"></span>桌宠在线</span>`;
  }
  return `<span class="status-pill disconnected"><span class="dot dot-danger"></span>桌宠离线</span>`;
}

function updateHealthBadges() {
  for (const el of document.querySelectorAll('.js-health')) {
    el.innerHTML = healthBadge();
  }
}

async function refreshHealth(force = false) {
  if (state.healthBusy) return;
  if (!force && state.health && Date.now() - state.healthCheckedAt < 15000) return;
  state.healthBusy = true;
  updateHealthBadges();
  try {
    state.health = await api('/api/dafeiyu/health');
  } catch (error) {
    state.health = { online: false, message: error.message };
  } finally {
    state.healthBusy = false;
    state.healthCheckedAt = Date.now();
    updateHealthBadges();
  }
}

function seatColor(def) {
  const colors = {
    black: '#1c252b',
    white: '#e9e1cf',
    gold: '#d6a84b',
    blue: '#759bc7',
    violet: '#a88bd8',
  };
  return colors[def?.color] ?? '#7e8d96';
}

function seatToken(def) {
  const ink = ['white', 'gold'].includes(def?.color) ? '#102018' : '#f4fbf7';
  return `<span class="seat-token" style="--seat-color:${escapeAttr(seatColor(def))};--seat-ink:${ink}" aria-hidden="true">${escapeHtml(def.shortName ?? def.name.slice(0, 1))}</span>`;
}

function renderGameCard(game) {
  const selected = game.id === state.lobby.gameId;
  const players = game.minPlayers === game.maxPlayers
    ? `${game.minPlayers} 人`
    : `${game.minPlayers}–${game.maxPlayers} 人`;
  return `
    <button class="game-card ${selected ? 'selected' : ''}" type="button" data-action="select-game" data-game="${escapeAttr(game.id)}" aria-pressed="${selected}">
      <div class="game-card-top">
        <span class="game-card-icon">${icon(game.id === 'gomoku' ? 'board' : 'users')}</span>
        <span class="game-card-count">${escapeHtml(players)}</span>
      </div>
      <h3>${escapeHtml(game.name)}</h3>
      <p>${escapeHtml(game.description ?? '')}</p>
      <div class="game-card-foot">
        <span>${game.seats.length} 席</span>
        <span>真人 / 模型 / 内置机器人 / 大肥鱼</span>
        <span>规则 v${escapeHtml(game.rulesVersion)}</span>
      </div>
      <span class="game-card-cta">${selected ? '当前选择' : '选择这个桌游'} ${selected ? icon('check', 'icon-sm') : icon('arrowRight', 'icon-sm')}</span>
    </button>`;
}

function renderSeatSetup(game, def, seat, index) {
  const selectedName = modelNameFor(seat);
  const color = seatColor(def);
  return `
    <div class="seat-setup dynamic-seat" style="--seat-color:${escapeAttr(color)}">
      <div class="seat-setup-head">
        <div class="seat-title">
          ${seatToken(def)}
          <div>
            <div class="seat-side">${escapeHtml(def.name)}</div>
            <div class="seat-turn-note">第 ${index + 1} 席 · ${index === 0 ? '先手' : `顺序 ${index + 1}`}</div>
          </div>
        </div>
        <span class="chip ${seat.kind === 'human' ? 'chip-accent' : seat.kind === 'dafeiyu' ? 'chip-gold' : ''}">${escapeHtml(KIND_LABELS[seat.kind])}</span>
      </div>
      <div class="seat-controls">
        <label class="field">
          <span class="field-label">座位身份</span>
          <select class="select" data-change="seat-kind" data-seat="${escapeAttr(def.id)}" aria-label="${escapeAttr(def.name)}座位身份">
            <option value="human" ${seat.kind === 'human' ? 'selected' : ''}>真人 · 我来下</option>
            <option value="bot" ${seat.kind === 'bot' ? 'selected' : ''}>内置机器人 · 无需 Key</option>
            <option value="model" ${seat.kind === 'model' ? 'selected' : ''}>普通模型 · 竞技场直连</option>
            <option value="dafeiyu" ${seat.kind === 'dafeiyu' ? 'selected' : ''}>大肥鱼 · 桌宠棋手</option>
          </select>
        </label>
        ${seat.kind === 'model' ? `
          <label class="field">
            <span class="field-label">模型配置 <a class="field-hint" href="#/models">管理模型</a></span>
            <select class="select" data-change="seat-model" data-seat="${escapeAttr(def.id)}" aria-label="选择模型">
              ${modelOptions(seat.modelId)}
            </select>
          </label>
          ${!state.models.length ? `<div class="notice notice-warn">${icon('alert')}<span>还没有模型配置。先到模型管理添加一个，或这一席改用内置机器人。</span></div>` : ''}
        ` : ''}
        ${['model', 'dafeiyu'].includes(seat.kind) ? `
          <label class="field">
            <span class="field-label">落子模式</span>
            <select class="select" data-change="seat-mode" data-seat="${escapeAttr(def.id)}" aria-label="落子模式">
              <option value="assisted" ${seat.moveMode !== 'pure' ? 'selected' : ''}>规则辅助 · 合法候选与战术提示</option>
              <option value="pure" ${seat.moveMode === 'pure' ? 'selected' : ''}>纯模型 · 只给规则和局面</option>
            </select>
            <span class="field-hint">规则辅助会加入合法候选、立即成五点和必堵点；纯模型用于比较模型本身。</span>
          </label>
        ` : ''}
      </div>
      <div class="seat-summary">
        ${seat.kind === 'model' ? icon('cpu') : seat.kind === 'dafeiyu' ? icon('spark') : seat.kind === 'bot' ? icon('bot') : icon('users')}
        <span><strong>${escapeHtml(selectedName)}</strong> · ${escapeHtml(seatSummary(seat))}</span>
      </div>
    </div>`;
}

function renderLobby() {
  const game = ensureLobbyGame();
  if (!game) {
    renderShell(`<div class="page"><div class="notice notice-warn">${icon('alert')}<span>没有找到可用的桌游插件。</span></div></div>`, 'lobby');
    return;
  }
  const seats = lobbySeats();
  const defs = orderedSeatDefs(game);
  const errors = validateLobby();
  const activeDafeiyu = lobbyDafeiyuActive();
  const hasDafeiyuSeat = lobbyHasDafeiyuSeat();
  const dafeiyuConfig = state.dafeiyu ?? state.boot?.dafeiyu ?? {};
  const allAi = defs.every((def) => seats[def.id]?.kind !== 'human');
  const firstSeat = defs[0];
  const validationNotice = errors.length
    ? `<div class="notice notice-warn mt-12">${icon('alert')}<span>${errors.map(escapeHtml).join('<br />')}</span></div>`
    : '';
  const playerLine = defs.map((def) => `
    <div class="start-seat">
      ${seatToken(def)}
      <span class="start-seat-side">${escapeHtml(def.name)}</span>
      <strong>${escapeHtml(modelNameFor(seats[def.id]))}</strong>
      ${seatModeLabel(seats[def.id]) ? `<span class="chip chip-subtle">${escapeHtml(seatModeLabel(seats[def.id]))}</span>` : ''}
    </div>`).join('');
  const content = `
    <div class="page library-page">
      <header class="library-head">
        <div>
          <p class="eyebrow">AI ARENA · LOCAL</p>
          <h1 class="page-title">桌游库</h1>
          <p class="page-subtitle">选一张桌子，安排座位，然后开始。模型、内置机器人和大肥鱼可以混坐。</p>
        </div>
        <div class="library-head-meta">
          <span class="chip chip-accent">${state.boot?.games?.length ?? 0} 款可玩</span>
          <span class="chip">${state.models.length} 个模型配置</span>
          <span class="js-health">${healthBadge()}</span>
        </div>
      </header>

      <section class="game-library" aria-labelledby="library-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">GAME LIBRARY</p>
            <h2 id="library-heading">可以玩的游戏</h2>
          </div>
          <span class="section-note">第一款正式游戏：自由五子棋</span>
        </div>
        <div class="game-grid">
          ${gameDefs().map(renderGameCard).join('')}
        </div>
      </section>

      <div class="lobby-layout">
        <section class="card seat-setup-card">
          <div class="setup-title-row">
            <div>
              <p class="eyebrow">TABLE SETUP · ${escapeHtml(game.id.toUpperCase())}</p>
              <h2>${escapeHtml(game.name)}</h2>
              <p>${escapeHtml(game.description ?? '')}</p>
            </div>
            <div class="setup-chips">
              <span class="chip chip-gold">${game.seats.length} 席</span>
              <span class="chip">规则 v${escapeHtml(game.rulesVersion)}</span>
            </div>
          </div>
          <div class="game-facts">
            <span>${defs.length === 2 ? '双人对局' : `${defs.length} 人同桌`}</span>
            <span>${allAi ? '可全 AI 观战' : '支持真人 + AI'}</span>
            <span>${game.supportsSpectator ? '大肥鱼可观战' : '仅对局'}</span>
            <span>${game.minPlayers === game.maxPlayers ? `${game.minPlayers} 人` : `${game.minPlayers}–${game.maxPlayers} 人`}</span>
          </div>
          <div class="seat-setup-grid" style="--seat-count:${defs.length}">
            ${defs.map((def, index) => renderSeatSetup(game, def, seats[def.id], index)).join('')}
          </div>
          <div class="seat-rules-note">
            ${icon('info')}
            <span>所有动作由同一个后端校验：座位、回合、规则、可见范围与终局。模型或大肥鱼返回非法动作时会有限重试，失败即暂停。</span>
          </div>
          ${validationNotice}
          <details class="rules-details game-rules">
            <summary>规则与座位说明</summary>
            <pre>${escapeHtml((game.rulesText ?? '').trim())}\n\n座位顺序：${defs.map((def) => `${escapeHtml(def.name)}（${escapeHtml(def.id)}）`).join(' → ')}</pre>
          </details>
        </section>

        <aside class="lobby-side">
          <section class="dafeiyu-invite">
            <div class="dafeiyu-head">
              <span class="whale-avatar" aria-hidden="true">鲸</span>
              <div>
                <h3>大肥鱼</h3>
                <p>桌宠观战 · 棋手接入 · 语音点评</p>
              </div>
              <span class="js-health" style="margin-left:auto">${healthBadge()}</span>
            </div>
            <div class="switch-row">
              <div class="switch-copy">
                <div class="switch-title">${icon('eye', 'icon-sm')} 邀请她观战</div>
                <div class="switch-desc">${hasDafeiyuSeat ? '她已入座棋手席，桌宠连接随座位开启。' : '读取公开棋盘，从双方视角点评。'}</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-change="lobby-observer" ${activeDafeiyu ? 'checked' : ''} ${hasDafeiyuSeat ? 'disabled' : ''} />
                <span class="switch-track"></span>
              </label>
            </div>
            <div class="switch-row">
              <div class="switch-copy">
                <div class="switch-title">${icon('spark', 'icon-sm')} 自动点评</div>
                <div class="switch-desc">只挑成五威胁、胜负手和终局；落子优先，过时点评会丢弃。</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-change="lobby-auto" ${state.lobby.autoComment ? 'checked' : ''} ${activeDafeiyu ? '' : 'disabled'} />
                <span class="switch-track"></span>
              </label>
            </div>
            <div class="switch-row">
              <div class="switch-copy">
                <div class="switch-title">${icon(state.lobby.voice ? 'volume' : 'volumeOff', 'icon-sm')} 语音播报</div>
                <div class="switch-desc">复用桌宠现有播报链路；关闭后仍显示文字。</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-change="lobby-voice" ${state.lobby.voice ? 'checked' : ''} ${activeDafeiyu ? '' : 'disabled'} />
                <span class="switch-track"></span>
              </label>
            </div>
            ${hasDafeiyuSeat ? `<div class="notice notice-accent">${icon('spark')}<span>大肥鱼已在棋手席。她只从自己的座位和可见局面发言；落子仍由竞技场校验。</span></div>` : ''}
            <div class="connection-line">
              <span>桌宠接口</span>
              <code>${escapeHtml(dafeiyuConfig.bridgeUrl ?? '未配置')}</code>
              <button class="btn btn-quiet btn-sm" type="button" data-action="check-health">${icon('refresh', 'icon-sm')} 检测</button>
            </div>
            <div class="fine-print">
              没有桌宠也能玩：内置机器人和模型配置足以完成对局与回放。
              <button class="btn btn-quiet btn-sm" type="button" data-action="open-dafeiyu-settings">连接设置</button>
            </div>
          </section>

          <section class="card start-panel">
            <div class="start-panel-head">
              <div>
                <p class="eyebrow">READY</p>
                <h3>这桌怎么坐</h3>
              </div>
              <span class="chip">${escapeHtml(game.name)}</span>
            </div>
            <div class="start-seat-list">${playerLine}</div>
            <button class="btn btn-primary btn-lg btn-block" type="button" data-action="start-match" ${errors.length ? 'disabled' : ''}>
              ${icon('play')} 开始对局
            </button>
            <button class="btn btn-quiet btn-block mt-8" type="button" data-action="quick-demo">
              ${icon('bot', 'icon-sm')} 快速试玩：我执${escapeHtml(firstSeat?.name ?? '首座')} vs 内置机器人
            </button>
            <div class="start-notes">
              <div class="start-note"><span class="dot dot-live"></span><span>${allAi ? '全部座位由 AI 控制：开局后可观战、暂停和单步推进。' : '你在自己座位行动，AI 回合自动进行。'}</span></div>
              <div class="start-note"><span class="dot"></span><span>服务只监听本机，第一次运行不需要网络。</span></div>
              <div class="start-note"><span class="dot"></span><span>模型 Key 仅保存在后端配置里，网页只能看到“已设置”。</span></div>
            </div>
          </section>
        </aside>
      </div>
    </div>`;
  renderShell(content, 'lobby');
  requestAnimationFrame(() => void refreshHealth());
}

function renderTestResult(result, { loading = false, title = '' } = {}) {
  if (loading) {
    return `<div class="model-test-result"><div class="test-summary"><span class="spinner"></span>正在连接模型…</div></div>`;
  }
  if (!result) return '';
  const ok = Boolean(result.ok);
  const checks = (result.checks ?? []).map((check) => {
    const mark = check.ok === true ? 'ok' : check.ok === false ? 'fail' : 'unknown';
    const symbol = check.ok === true ? '✓' : check.ok === false ? '×' : '·';
    return `<div class="check-row">
      <span class="check-mark ${mark}">${symbol}</span>
      <span><span class="check-name">${escapeHtml(check.name)}</span>${check.detail ? `<br />${escapeHtml(check.detail)}` : ''}</span>
    </div>`;
  }).join('');
  const detail = ok
    ? `耗时 ${result.durationMs ?? 0} ms`
    : escapeHtml(result.error?.message ?? '连接失败');
  return `
    <div class="model-test-result ${ok ? 'ok' : 'fail'}">
      <div class="test-summary ${ok ? 'ok' : 'fail'}">
        ${icon(ok ? 'check' : 'alert')}
        <span>${escapeHtml(title || (ok ? '连接成功' : '连接失败'))}</span>
        <span class="caption" style="margin-left:auto">${detail}</span>
      </div>
      <div class="check-list">${checks}</div>
    </div>`;
}

function renderModelCard(model) {
  const test = state.modelTests[model.id];
  return `
    <article class="model-card" data-model-id="${escapeAttr(model.id)}">
      <div class="model-head">
        <div>
          <div class="model-sub" style="margin-top:0;margin-bottom:8px">
            <span class="chip ${model.isExample ? 'chip-gold' : 'chip-accent'}">${model.isExample ? '本地示例' : '模型配置'}</span>
            <span class="chip">${escapeHtml(model.providerLabel)}</span>
          </div>
          <h2 class="model-name">${escapeHtml(model.name)}</h2>
          <div class="model-id">${escapeHtml(model.modelId)}</div>
        </div>
        <span class="model-badge">${icon('cpu')}</span>
      </div>
      <div class="model-meta">
        <div class="model-meta-row"><span class="model-meta-label">Base URL</span><span class="model-meta-value">${escapeHtml(model.baseUrl)}</span></div>
        <div class="model-meta-row"><span class="model-meta-label">请求端点</span><span class="model-meta-value">${escapeHtml(model.endpoint)}</span></div>
        <div class="model-meta-row"><span class="model-meta-label">超时 / 重试</span><span class="model-meta-value">${Math.round(Number(model.timeoutMs) / 1000)} 秒 / ${model.maxRetries ?? 2} 次</span></div>
        <div class="model-meta-row">
          <span class="model-meta-label">API Key</span>
          <span class="model-key-state ${model.hasApiKey ? 'set' : 'unset'}">${icon(model.hasApiKey ? 'shield' : 'x', 'icon-sm')} ${model.hasApiKey ? '已设置 · 不回传浏览器' : '未设置 / 无 Key'}</span>
        </div>
      </div>
      ${test ? `<div class="test-result-panel">${renderTestResult(test.result, { loading: test.loading })}</div>` : ''}
      <div class="model-card-actions">
        <button class="btn btn-sm" type="button" data-action="test-model" data-id="${escapeAttr(model.id)}">${icon('plug', 'icon-sm')} 测试连接</button>
        <button class="btn btn-quiet btn-sm" type="button" data-action="edit-model" data-id="${escapeAttr(model.id)}">${icon('edit', 'icon-sm')} 编辑</button>
        <button class="icon-btn" type="button" data-action="delete-model" data-id="${escapeAttr(model.id)}" aria-label="删除 ${escapeAttr(model.name)}">${icon('trash', 'icon-sm')}</button>
      </div>
    </article>`;
}

function renderModels() {
  const dafeiyuConfig = state.dafeiyu ?? {};
  const content = `
    <div class="page">
      ${renderPageHead({
        eyebrow: 'MODEL CONNECTIONS',
        title: '模型管理',
        subtitle: '竞技场在后端直连 OpenAI 兼容接口。API Key 只保存在本机配置文件中，配置读取、对局记录、日志和回放导出都不会返回它。',
        actions: `<button class="btn" type="button" data-action="refresh-models">${icon('refresh')} 刷新</button>
          <button class="btn btn-primary" type="button" data-action="create-model">${icon('plus')} 新增模型</button>`,
      })}
      <div class="models-layout">
        <section class="card card-pad">
          <div class="section-head">
            <div>
              <h2 class="section-title">${icon('cpu')} 已保存的接口</h2>
              <p class="section-note">${state.models.length} 个配置。同一局的两个 AI 座位可以指向不同供应商或本机模型。</p>
            </div>
            <span class="chip">${icon('shield', 'icon-sm')} Key 后端持有</span>
          </div>
          ${state.models.length
            ? `<div class="models-list">${state.models.map(renderModelCard).join('')}</div>`
            : `<div class="empty-state">
                <span class="empty-icon">${icon('cpu')}</span>
                <h3>还没有模型配置</h3>
                <p>新增一个 OpenAI 兼容接口，或先用桌游库的内置机器人试玩。本地 KVMem 示例会在首次启动时生成，你可以直接编辑它。</p>
                <button class="btn btn-primary" type="button" data-action="create-model">${icon('plus')} 新增第一个模型</button>
              </div>`}
          <details class="doc-details mt-16">
            <summary>接口约定与供应商扩展</summary>
            <p>第一版支持 OpenAI Chat Completions 协议。Base URL 可以填 <code>http://host:port</code> 或 <code>http://host:port/v1</code>，末尾斜杠会被自动处理。空 Key 不会发送 Authorization 头；Key 会以 <code>Bearer &lt;Key&gt;</code> 发送。</p>
            <p>新的供应商协议应由开发者在 <code>packages/models/</code> 注册适配器，并复用统一错误分类；说明见仓库的 <code>docs/add-model.md</code>。</p>
          </details>
        </section>

        <section class="card card-pad config-section">
          <div class="config-head">
            <div>
              <h2>大肥鱼桌宠连接</h2>
              <p>这是竞技场到桌宠后端的本机接口。大肥鱼的人设、模型和语音由桌宠维护；竞技场只发送当前身份可见的公开局面。</p>
            </div>
            <span class="js-health">${healthBadge()}</span>
          </div>
          <div class="config-grid">
            <div class="config-item">
              <div class="config-item-label">桌宠服务</div>
              <div class="config-item-value">${escapeHtml(dafeiyuConfig.bridgeUrl || '未配置')}</div>
            </div>
            <div class="config-item">
              <div class="config-item-label">Arena API</div>
              <div class="config-item-value">${escapeHtml(dafeiyuConfig.apiBase || '/api/game/arena')}</div>
            </div>
            <div class="config-item">
              <div class="config-item-label">接入令牌</div>
              <div class="config-item-value">${dafeiyuConfig.hasToken ? '已设置（不回显）' : '未设置（本机默认）'}</div>
            </div>
          </div>
          <div class="button-row">
            <button class="btn" type="button" data-action="check-health">${icon('plug')} 检测桌宠</button>
            <button class="btn btn-quiet" type="button" data-action="open-dafeiyu-settings">${icon('settings')} 编辑连接</button>
            <span class="caption">未启动桌宠时，模型与内置机器人仍可正常使用。</span>
          </div>
          <div class="notice notice-info">
            ${icon('info')}
            <span>普通 KVMem 座位由竞技场直接请求模型；大肥鱼座位由桌宠参与，并在界面标记为「大肥鱼 · 桌宠服务」。两者不会混用配置。</span>
          </div>
        </section>
      </div>
    </div>`;
  renderShell(content, 'models');
  requestAnimationFrame(() => void refreshHealth());
}

async function loadModelsData() {
  const [models, dafeiyu] = await Promise.all([
    api('/api/models'),
    api('/api/dafeiyu/config'),
  ]);
  state.models = models.models;
  if (state.boot) state.boot.models = models.models;
  state.dafeiyu = dafeiyu.dafeiyu;
  if (state.boot) state.boot.dafeiyu = dafeiyu.dafeiyu;
}

async function handleRoute() {
  const route = parseRoute();
  const previous = state.route;
  if (previous?.name === 'match'
    && (route.name !== 'match' || route.id !== previous.id)
    && state.match?.id === previous.id) {
    releaseMatchSession(previous.id, '离开对局页面');
  }
  closeMatchStream();
  state.route = route;
  if (route.name === 'lobby') {
    renderLobby();
    return;
  }
  if (route.name === 'models') {
    renderLoading('models');
    try {
      await loadModelsData();
      renderModels();
    } catch (error) {
      renderShell(`<div class="page"><div class="error-page"><div class="card card-pad error-box"><h1>模型管理不可用</h1><p>${escapeHtml(error.message)}</p><button class="btn mt-12" data-action="reload-page">刷新页面</button></div></div></div>`, 'models');
    }
    return;
  }
  if (route.name === 'history') {
    renderLoading('history');
    try {
      await loadHistory();
      renderHistory();
    } catch (error) {
      renderShell(`<div class="page"><div class="error-page"><div class="card card-pad error-box"><h1>对局记录不可用</h1><p>${escapeHtml(error.message)}</p><button class="btn mt-12" data-action="reload-page">刷新页面</button></div></div></div>`, 'history');
    }
    return;
  }
  if (route.name === 'match') {
    state.chatDraft = '';
    renderLoading('lobby', '正在载入对局');
    try {
      const data = await api(`/api/matches/${encodeURIComponent(route.id)}`);
      state.match = data.match;
      renderMatchPage();
      openMatchStream(route.id);
    } catch (error) {
      renderShell(`<div class="page">
        <a class="back-link" href="#/history">${icon('arrowLeft')} 返回对局记录</a>
        <div class="error-page"><div class="card card-pad error-box"><h1>找不到这局对局</h1><p>${escapeHtml(error.message)}</p><a class="btn btn-primary mt-12" href="#/lobby">回到桌游库</a></div></div>
      </div>`, 'lobby');
    }
    return;
  }
  if (route.name === 'replay') {
    renderLoading('history', '正在载入回放');
    try {
      const replay = await api(`/api/matches/${encodeURIComponent(route.id)}/replay`);
      state.replay = replay;
      state.replayStep = replay.totalSteps;
      renderReplayPage();
    } catch (error) {
      renderShell(`<div class="page">
        <a class="back-link" href="#/history">${icon('arrowLeft')} 返回对局记录</a>
        <div class="error-page"><div class="card card-pad error-box"><h1>这局回放打不开</h1><p>${escapeHtml(error.message)}</p><a class="btn btn-primary mt-12" href="#/history">回到对局记录</a></div></div>
      </div>`, 'history');
    }
  }
}

async function loadHistory() {
  const params = new URLSearchParams();
  const { player, result, status, game, q } = state.historyFilters;
  if (player) params.set('player', player);
  if (result) params.set('result', result);
  if (status) params.set('status', status);
  if (game) params.set('game', game);
  if (q) params.set('q', q);
  const data = await api(`/api/matches?${params.toString()}`);
  state.historyItems = data.matches;
}

function historyFiltersHtml() {
  const { player, result, status, game, q } = state.historyFilters;
  return `
    <form class="history-filters" data-form="history">
      <label class="field">
        <span class="field-label">玩家 / 模型</span>
        <input class="input" name="player" value="${escapeAttr(player)}" placeholder="例如 大肥鱼、内置机器人" />
      </label>
      <label class="field">
        <span class="field-label">桌游</span>
        <select class="select" name="game">
          <option value="">全部桌游</option>
          ${gameDefs().map((item) => `<option value="${escapeAttr(item.id)}" ${game === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field-label">结果</span>
        <select class="select" name="result">
          <option value="">全部结果</option>
          <option value="win" ${result === 'win' || result === 'black_win' || result === 'white_win' ? 'selected' : ''}>有胜负</option>
          <option value="draw" ${result === 'draw' ? 'selected' : ''}>和棋</option>
          <option value="aborted" ${result === 'aborted' ? 'selected' : ''}>已中止</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">状态</span>
        <select class="select" name="status">
          <option value="">全部状态</option>
          <option value="playing" ${status === 'playing' ? 'selected' : ''}>进行中</option>
          <option value="paused" ${status === 'paused' ? 'selected' : ''}>已暂停</option>
          <option value="finished" ${status === 'finished' ? 'selected' : ''}>已结束</option>
          <option value="aborted" ${status === 'aborted' ? 'selected' : ''}>已中止</option>
        </select>
      </label>
      <div class="button-row history-buttons">
        <button class="btn btn-primary" type="submit">${icon('list')} 筛选</button>
        <button class="btn btn-quiet" type="button" data-action="clear-history-filters">清空</button>
      </div>
      <div class="history-search" style="grid-column:1/-1">
        <label class="field" style="gap:5px">
          <span class="field-label">搜索</span>
          <input class="input" name="q" value="${escapeAttr(q)}" placeholder="对局 ID、桌游或玩家" />
        </label>
      </div>
    </form>`;
}

function historyResultHtml(match) {
  const group = match.resultGroup
    ?? (['black_win', 'white_win'].includes(match.result) ? 'win' : match.result);
  const label = group === 'win' ? '有胜负' : group === 'draw' ? '和棋' : group === 'aborted' ? '已中止' : (RESULT_LABELS[match.result] ?? match.result ?? '—');
  const cls = group === 'win' ? 'chip-gold' : group === 'aborted' ? 'chip-danger' : group === 'draw' ? '' : 'chip-muted';
  return `<div class="history-result"><span class="chip ${cls}">${escapeHtml(label)}</span><small>${escapeHtml(match.resultLabel ?? '')}</small></div>`;
}

function renderHistoryRow(match) {
  const order = match.seatOrder?.length ? match.seatOrder : Object.keys(match.seats ?? {});
  const terminal = match.status === 'finished' || match.status === 'aborted';
  const game = gameDef(match.gameId);
  return `
    <div class="history-row">
      <div class="history-when">
        <strong>${escapeHtml(match.id)}</strong>
        ${formatDateTime(match.createdAt)} · ${escapeHtml(match.gameName ?? '桌游')}
      </div>
      <div class="history-players dynamic-history-seats">
        ${order.map((id) => {
          const seat = match.seats?.[id];
          if (!seat) return '';
          const def = seatDefFor({ ...match, game }, id);
          return `<span class="history-player" style="--seat-color:${escapeAttr(seatColor(def))}">${seatToken(def)}<span>${escapeHtml(seat.name)}</span>${seatModeLabel(seat) ? `<small>${escapeHtml(seatModeLabel(seat))}</small>` : ''}</span>`;
        }).join('')}
      </div>
      ${historyResultHtml(match)}
      <div class="history-meta">
        ${escapeHtml(match.modeLabel ?? '')}<br />
        ${match.moveCount} 手 · 规则 v${escapeHtml(match.rulesVersion ?? '1.0.0')}
      </div>
      <div class="history-actions">
        ${terminal
          ? `<button class="btn btn-sm" type="button" data-action="open-replay" data-id="${escapeAttr(match.id)}">${icon('history', 'icon-sm')} 回放</button>`
          : `<button class="btn btn-sm btn-primary" type="button" data-action="open-match" data-id="${escapeAttr(match.id)}">${icon('eye', 'icon-sm')} 观战</button>`}
      </div>
    </div>`;
}

function renderHistory() {
  const content = `
    <div class="page">
      ${renderPageHead({
        eyebrow: 'ARCHIVE',
        title: '对局记录',
        subtitle: '规则版本、座位、模型名称、逐手动作、公开发言和结果都保存在本机。回放只读取权威快照，不调用模型，也不播放语音。',
        actions: `<button class="btn" type="button" data-action="refresh-history">${icon('refresh')} 刷新</button>`,
      })}
      <section class="card history-shell">
        ${historyFiltersHtml()}
        ${state.historyItems.length
          ? `<div class="history-list">${state.historyItems.map(renderHistoryRow).join('')}</div>`
          : `<div class="empty-state">
              <span class="empty-icon">${icon('history')}</span>
              <h3>还没有符合条件的对局</h3>
              <p>${state.historyFilters.player || state.historyFilters.result || state.historyFilters.status || state.historyFilters.game || state.historyFilters.q ? '换个筛选条件试试，或清空筛选。' : '完成一局后，它会自动出现在这里。可以先到桌游库用内置机器人跑完一局。'}</p>
              <a class="btn btn-primary" href="#/lobby">${icon('board')} 去开一局</a>
            </div>`}
      </section>
    </div>`;
  renderShell(content, 'history');
}

function dafeiyuStatusInfo(dafeiyu) {
  if (!dafeiyu?.enabled || dafeiyu.status === 'off') return { label: '未开启', cls: 'off' };
  if (dafeiyu.status === 'connected') return { label: '已连接', cls: 'connected' };
  if (dafeiyu.status === 'connecting') return { label: '连接中', cls: 'connecting' };
  return { label: '已断开', cls: 'disconnected' };
}

function seatStrip(match, view) {
  const order = match.seatOrder?.length
    ? match.seatOrder
    : Object.keys(match.seats ?? {}).sort((a, b) => (match.seats[a].order ?? 0) - (match.seats[b].order ?? 0));
  const current = match.turnSeat ?? view?.turn ?? null;
  return `<div class="seats-strip dynamic-seats" data-seat-count="${order.length}">
    ${order.map((id) => {
      const seat = match.seats[id];
      if (!seat) return '';
      const def = seatDefFor(match, id);
      const active = current === id && !match.outcome;
      const winner = match.outcome?.winnerSeat === id;
      return `
        <div class="match-seat ${active ? 'active' : ''} ${winner ? 'winner' : ''}" style="--seat-color:${escapeAttr(seatColor(def))}">
          ${seatToken(def)}
          <div class="match-seat-copy">
            <div class="match-seat-label">${escapeHtml(seat.colorName ?? def.name)} ${seatKindChip(seat)} ${seatModeLabel(seat) ? `<span class="chip chip-subtle">${escapeHtml(seatModeLabel(seat))}</span>` : ''}</div>
            <div class="match-seat-name">${escapeHtml(seat.name)}</div>
            <div class="match-seat-engine">${escapeHtml(seat.engineLabel)}</div>
          </div>
        </div>`;
    }).join('')}
    <div class="seat-center"><strong>${match.actionCount ?? view?.moveCount ?? 0}</strong><small>手 / MOVES</small></div>
  </div>`;
}

function boardCellHtml({ row, col, view, interactive, humanColor, winningSet, lastMove }) {
  const value = view.board?.[row]?.[col] ?? null;
  const coord = `${'ABCDEFGHIJKLMNO'[col]}${15 - row}`;
  const isLast = lastMove && lastMove.row === row && lastMove.col === col;
  const isWinning = winningSet.has(`${row}:${col}`);
  const starPoints = new Set(['3:3', '3:11', '7:7', '11:3', '11:11']);
  const className = [
    'cell',
    value ? 'occupied' : '',
    interactive && !value ? 'is-playable' : '',
    isWinning ? 'winning' : '',
    starPoints.has(`${row}:${col}`) ? 'has-star' : '',
  ].filter(Boolean).join(' ');
  const label = value
    ? `${coord} ${value === 'black' ? '黑子' : '白子'}${isLast ? '，最后一手' : ''}`
    : `${coord} 空点${interactive ? '，可落子' : ''}`;
  return `<button
    type="button"
    class="${className}"
    aria-label="${escapeAttr(label)}"
    ${interactive && !value ? `data-action="play-move" data-coord="${coord}"` : 'disabled'}
    ${value ? 'tabindex="-1"' : ''}
  >
    ${value ? `<span class="stone ${value} ${isLast ? 'latest' : ''}"></span>` : ''}
    ${!value && interactive && humanColor ? `<span class="ghost-stone ${humanColor}"></span>` : ''}
    ${starPoints.has(`${row}:${col}`) && !value ? '<span class="star"></span>' : ''}
    ${isLast ? '<span class="last-marker"></span>' : ''}
  </button>`;
}

function winLineSvg(winningLine) {
  if (!Array.isArray(winningLine) || winningLine.length < 2) return '';
  const first = winningLine[0];
  const last = winningLine[winningLine.length - 1];
  const x1 = ((first.col + 0.5) / 15) * 100;
  const y1 = ((first.row + 0.5) / 15) * 100;
  const x2 = ((last.col + 0.5) / 15) * 100;
  const y2 = ((last.row + 0.5) / 15) * 100;
  return `<svg class="win-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
  </svg>`;
}

function renderBoard({ view, interactive = false, humanColor = null, seats = null }) {
  const winningSet = new Set((view.winningLine ?? []).map((cell) => `${cell.row}:${cell.col}`));
  const columns = (view.columns ?? 'ABCDEFGHIJKLMNO').split('');
  const rows = view.rowLabels ?? Array.from({ length: 15 }, (_, index) => 15 - index);
  return `
    <div class="board-coordinates">
      <div class="coord-corner"></div>
      <div class="col-labels" aria-hidden="true">${columns.map((col) => `<span>${escapeHtml(col)}</span>`).join('')}</div>
      <div class="row-labels" aria-hidden="true">${rows.map((row) => `<span>${escapeHtml(row)}</span>`).join('')}</div>
      <div class="board-surface" tabindex="0" aria-label="${escapeAttr(seats ? `${Object.values(seats).map((seat) => seat.name).join(' 对 ')} 的五子棋棋盘` : '五子棋棋盘')}">
        <div class="board-grid">
          ${view.board.map((row, rowIndex) => row.map((_, colIndex) => boardCellHtml({
            row: rowIndex,
            col: colIndex,
            view,
            interactive,
            humanColor,
            winningSet,
            lastMove: view.lastMove,
          })).join('')).join('')}
        </div>
        ${winLineSvg(view.winningLine)}
      </div>
    </div>`;
}

function boardCard({ match, view, interactive, humanColor, title = '对局桌面' }) {
  const lastMove = view.lastMove;
  return `
    <section class="board-card gomoku-surface">
      <div class="board-card-head">
        <div class="board-card-title">${icon('board', 'icon-sm')} ${escapeHtml(title)} <span class="chip">15×15 · 自由五子棋</span></div>
        <div class="board-last-move">最后一手 ${lastMove ? `<strong>${escapeHtml(lastMove.move)}</strong> · ${escapeHtml(match.seats[lastMove.seat]?.colorName ?? match.seats[lastMove.seat]?.name ?? '')}` : '—'}</div>
      </div>
      ${renderBoard({ view, interactive, humanColor, seats: match.seats })}
      <div class="board-footnote">
        <span>坐标 A-O / 15-1 · H8 天元 · 黑先 · 无禁手</span>
        <span class="mono">${interactive ? '轮到你落子：点击空点' : '只读局面'}</span>
      </div>
    </section>`;
}

function threeSeatSurface({ match, view, interactive, title = '对局桌面' }) {
  const order = match.seatOrder?.length ? match.seatOrder : Object.keys(match.seats ?? {});
  const current = match.turnSeat ?? view?.turn ?? null;
  const last = view?.lastMove;
  const colorFor = (seatId) => {
    const def = seatDefFor(match, seatId);
    return seatColor(def);
  };
  return `
    <section class="board-card three-seat-surface">
      <div class="board-card-head">
        <div class="board-card-title">${icon('users', 'icon-sm')} ${escapeHtml(title)} <span class="chip">3 席 · 私有目标</span></div>
        <div class="board-last-move">最后一手 ${last ? `<strong>第 ${last.cell} 格</strong> · ${escapeHtml(match.seats[last.seat]?.colorName ?? match.seats[last.seat]?.name ?? '')}` : '—'}</div>
      </div>
      <div class="three-seat-wrap">
        <div class="three-seat-legend">
          ${order.map((id) => `<span class="legend-seat" style="--seat-color:${escapeAttr(colorFor(id))}"><i></i>${escapeHtml(match.seats[id]?.colorName ?? id)}</span>`).join('')}
        </div>
        <div class="three-seat-grid" tabindex="0" role="group" aria-label="三席测试局桌面">
          ${Array.from({ length: 9 }, (_, index) => {
            const row = Math.floor(index / 3);
            const col = index % 3;
            const owner = view.board?.[row]?.[col] ?? null;
            const isLast = last?.cell === index + 1;
            const winningCell = new Set(view.outcome?.line ?? []).has(index);
            const ownerDef = owner ? seatDefFor(match, owner) : null;
            const ownerShort = ownerDef?.shortName
              ?? match.seats[owner]?.colorName?.slice(0, 1)
              ?? match.seats[owner]?.name?.slice(0, 1)
              ?? '·';
            return `<button class="three-seat-cell ${owner ? 'occupied' : ''} ${interactive && !owner ? 'is-playable' : ''} ${winningCell ? 'winning' : ''}" type="button"
              style="--seat-color:${escapeAttr(owner ? colorFor(owner) : 'transparent')}"
              ${interactive && !owner ? `data-action="play-cell" data-cell="${index + 1}"` : 'disabled'}
              aria-label="第 ${index + 1} 格${owner ? `，${escapeHtml(match.seats[owner]?.colorName ?? owner)}` : '，空'}">
              ${owner ? `<span class="three-seat-token">${escapeHtml(ownerShort)}</span>` : `<span class="three-seat-index">${index + 1}</span>`}
              ${isLast ? '<span class="last-marker"></span>' : ''}
            </button>`;
          }).join('')}
        </div>
        <p class="board-footnote">金 → 月 → 星轮流占格。公开局面不显示私有目标；每个 AI 只在自己的座位视图里看到目标。</p>
      </div>
    </section>`;
}

/**
 * 桌游界面组件注册表。新桌游可在这里按 gameId 注册自己的桌面 DOM 组件；
 * 后端插件接口、座位、回合、模型调用、事件与回放不需要跟着复制。
 * 未注册时仍会显示一个只读的通用局面摘要，保证历史不会打不开。
 */
const GAME_SURFACES = {
  gomoku: (context) => boardCard(context),
  'three-seat-test': (context) => threeSeatSurface(context),
};

function renderGenericGameSurface({ match, view, title = '局面' }) {
  return `
    <section class="board-card">
      <div class="board-card-head">
        <div class="board-card-title">${icon('board', 'icon-sm')} ${escapeHtml(title)}</div>
        <span class="chip">通用组件</span>
      </div>
      <div class="notice notice-info">${icon('info')}<span>这局使用的桌游还没有专属网页组件。基础局面仍由插件提供，可在接口或回放数据中查看；为它添加组件的位置见 docs/add-game.md。</span></div>
      <pre class="state-json">${escapeHtml(JSON.stringify(view, null, 2))}</pre>
    </section>`;
}

function renderGameSurface(context) {
  const renderer = GAME_SURFACES[context.match?.gameId];
  return renderer ? renderer(context) : renderGenericGameSurface(context);
}

function matchStatusBanner(match) {
  const pending = match.pending;
  const current = match.turnSeat ?? match.state?.turn;
  const currentName = match.turnSeatName ?? match.seats?.[current]?.colorName ?? match.seats?.[current]?.name ?? '当前席位';
  let cls = 'playing';
  let title = '对局进行中';
  let desc = '按座位顺序行动。';
  let iconName = 'board';
  let side = '';

  if (match.status === 'paused') {
    cls = 'paused';
    iconName = pending ? 'clock' : 'pause';
    title = pending ? (pending.sourceLabel ?? 'AI 思考中') : '对局已暂停';
    desc = match.pause?.reason ?? '等待你继续。';
    side = `<span class="chip chip-gold">${match.pause?.code ? escapeHtml(match.pause.code) : 'PAUSED'}</span>`;
  } else if (match.status === 'finished') {
    cls = 'finished';
    iconName = 'flag';
    title = match.resultLabel ?? '对局结束';
    desc = match.outcome?.type === 'win'
      ? (match.outcome.length
        ? `${match.winnerName ?? currentName} 以 ${match.outcome.move ?? match.lastActionText ?? '最后一手'} 完成 ${match.outcome.length} 子连线，可以复盘或导出记录。`
        : `${match.winnerName ?? currentName} 以 ${match.outcome.move ?? match.outcome.cell ?? match.lastActionText ?? '最后一手'} 获胜，可以复盘或导出记录。`)
      : match.outcome?.type === 'draw'
        ? '规则判定和棋，可以复盘或导出记录。'
        : (match.outcome?.reason ?? '对局结束。');
    side = `<a class="btn btn-sm btn-gold" href="#/replay/${encodeURIComponent(match.id)}">${icon('history', 'icon-sm')} 看回放</a>`;
  } else if (match.status === 'aborted') {
    cls = 'aborted';
    iconName = 'x';
    title = '对局已中止';
    desc = match.outcome?.reason ?? '这局对局没有产生胜负。';
  } else {
    iconName = 'spark';
    if (pending) {
      cls = 'playing pending';
      title = pending.sourceLabel ?? '等待 AI 行动';
      desc = pending.kind === 'dafeiyu'
        ? '大肥鱼正在落子；低优先级点评已让位。棋局不会等待语音播报。'
        : pending.kind === 'model'
          ? '正在等待模型返回结构化动作。暂停或结束后，迟到的回复会作废。'
          : '内置机器人正在按规则选择动作。';
      side = `<span class="status-pill connecting"><span class="dot dot-warn"></span>AI 行动中</span>`;
    } else if (match.controls?.isHumanTurn) {
      title = '轮到你行动';
      desc = `现在由 ${currentName} · ${match.seats?.[current]?.name ?? ''} 行动。`;
    } else {
      title = match.controls?.allAi ? '全 AI 对局 · 可观战' : `等待 ${currentName} 行动`;
      desc = '可以随时暂停；暂停后可由后端单步推进或继续。';
    }
  }

  return `
    <div class="match-status-banner ${cls}">
      <div class="match-status-icon">${icon(iconName)}</div>
      <div class="match-status-copy">
        <div class="match-status-title">${escapeHtml(title)}</div>
        <div class="match-status-desc">${escapeHtml(desc)}</div>
      </div>
      <div class="match-status-side">
        ${side}
        ${match.viewers ? `<span class="chip">${icon('eye', 'icon-sm')} ${match.viewers} 人观战</span>` : ''}
      </div>
    </div>`;
}

function chatTag(chat) {
  if (chat.kind === 'comment') return chat.seat ? '棋手点评' : '观战点评';
  if (chat.kind === 'answer') return chat.seat ? '棋手回答' : '观战回答';
  if (chat.kind === 'thought') return '棋手公开想法';
  if (chat.kind === 'question') return '提问';
  return '系统';
}

function voiceNote(chat, dafeiyu) {
  if (!chat.voiceStatus || chat.voiceStatus === 'off') return '';
  if (chat.voiceStatus === 'cancelled') return '<div class="voice-note">语音已取消</div>';
  if (!dafeiyu?.voice) return '';
  const map = {
    queued: '语音已排队',
    playing: '语音播放中',
    played: '语音已播放',
    no_client: '桌宠窗口未连接，仅显示文字',
    busy: '桌宠正忙，仅显示文字',
    failed: '语音未播放，仅显示文字',
    unknown: '语音状态未知',
  };
  return `<div class="voice-note">${escapeHtml(map[chat.voiceStatus] ?? '仅显示文字')}</div>`;
}

function renderChatMessages(match, { chat = null, emptyText = '还没有公开发言。' } = {}) {
  const items = chat ?? match.chat ?? [];
  if (!items.length) {
    return `<div class="chat-empty">${escapeHtml(emptyText)}</div>`;
  }
  return items.map((message) => {
    const role = ['user', 'dafeiyu', 'ai', 'system'].includes(message.role) ? message.role : 'system';
    const seat = message.seat ? match.seats?.[message.seat] : null;
    const seatName = seat ? (seat.colorName ?? seat.name) : null;
    const baseAuthor = message.authorName
      ?? seat?.name
      ?? (role === 'dafeiyu' ? '大肥鱼' : role === 'ai' ? 'AI' : '竞技场');
    const author = message.role === 'user'
      ? '你'
      : message.role === 'dafeiyu' && seatName
        ? `${seatName} · ${baseAuthor}`
        : baseAuthor;
    const avatar = message.role === 'user'
      ? '你'
      : message.role === 'dafeiyu'
        ? '鲸'
        : message.role === 'ai'
          ? 'AI'
          : '·';
    return `
      <div class="chat-message ${role}${seat ? ' seat-speech' : ''}" ${seat ? `style="--seat-color:${escapeAttr(seatColor(seatDefFor(match, seat.id)))}"` : ''}>
        <span class="chat-avatar" aria-hidden="true">${escapeHtml(avatar)}</span>
        <div class="chat-body">
          <div class="chat-meta">
            <span class="chat-author">${escapeHtml(author)}</span>
            <span class="chat-tag">${escapeHtml(chatTag(message))}</span>
            <span>${formatDateTime(message.at)}</span>
          </div>
          <div class="chat-bubble">${escapeHtml(message.text)}</div>
          ${voiceNote(message, match.dafeiyu)}
        </div>
      </div>`;
  }).join('');
}

function hasDafeiyuSeat(match) {
  return Object.values(match.seats ?? {}).some((seat) => seat.kind === 'dafeiyu');
}

function dafeiyuSeatOf(match) {
  return Object.values(match.seats ?? {}).find((seat) => seat.kind === 'dafeiyu') ?? null;
}

function renderDafeiyuCard(match) {
  const dafeiyu = match.dafeiyu ?? {};
  const status = dafeiyuStatusInfo(dafeiyu);
  const seat = dafeiyuSeatOf(match);
  const seatBound = Boolean(seat);
  const archived = Boolean(match.archived);
  const connected = dafeiyu.status === 'connected';
  const enabled = dafeiyu.enabled;
  const busyMoving = match.pending?.kind === 'dafeiyu';
  const cardSub = seatBound
    ? `${seat.colorName ?? seat.name} · 棋手席`
    : '观战席 · 公开局面';
  return `
    <section class="side-card dafeiyu-side">
      <div class="side-card-head">
        <div class="dafeiyu-id">
          <span class="whale-avatar" aria-hidden="true">鲸</span>
          <div>
            <div class="dafeiyu-name">${escapeHtml(dafeiyu.personaName || '大肥鱼')}</div>
            <div class="dafeiyu-sub">${escapeHtml(cardSub)}</div>
          </div>
        </div>
        ${statusPill(status.cls, status.label)}
      </div>
      <div class="side-card-body">
        ${!enabled ? `
          <div class="dafeiyu-empty">
            <p>她还没有加入这局。开启后，大肥鱼会读取公开棋盘，在关键局势点评；也可以直接向她提问。</p>
            ${!archived && match.controls?.canToggleDafeiyu ? `<button class="btn btn-primary btn-block" type="button" data-action="invite-dafeiyu">${icon('spark')} 邀请大肥鱼观战</button>` : ''}
          </div>
        ` : `
          <div class="dafeiyu-toggles">
            <div class="switch-row">
              <div class="switch-copy">
                <div class="switch-title">${icon('spark', 'icon-sm')} 自动点评</div>
                <div class="switch-desc">${seatBound ? '从自己的座位视角短评；轮到自己落子时点评自动让位。' : '从双方视角点评，带冷却和事件去重。'}</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-change="match-auto" ${dafeiyu.autoComment ? 'checked' : ''} ${archived ? 'disabled' : ''} />
                <span class="switch-track"></span>
              </label>
            </div>
            <div class="switch-row">
              <div class="switch-copy">
                <div class="switch-title">${icon(dafeiyu.voice ? 'volume' : 'volumeOff', 'icon-sm')} 语音播报</div>
                <div class="switch-desc">${dafeiyu.voice ? '文字照常显示，语音由桌宠队列播放。' : '只显示文字，不请求桌宠语音。关闭时会取消仍在等待的旧播报。'}</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-change="match-voice" ${dafeiyu.voice ? 'checked' : ''} ${archived ? 'disabled' : ''} />
                <span class="switch-track"></span>
              </label>
            </div>
          </div>
          ${dafeiyu.lastError ? `<div class="notice notice-danger">${icon('alert')}<span>${escapeHtml(dafeiyu.lastError.message ?? '大肥鱼连接异常')}</span></div>` : ''}
          ${!connected && !archived ? `
            <div class="button-row mt-12">
              ${match.controls?.canReconnect ? `<button class="btn btn-primary btn-sm" type="button" data-action="reconnect-dafeiyu">${icon('plug', 'icon-sm')} 重新连接</button>` : ''}
              ${!seatBound && !archived ? `<button class="btn btn-quiet btn-sm" type="button" data-action="stop-observer">关闭观战</button>` : ''}
            </div>
          ` : ''}
          ${seatBound && !connected ? `<p class="caption mt-8">她是本局棋手。掉线或离开页面都会暂停棋局；重连并确认后可以继续。</p>` : ''}
          ${connected ? `<div class="connection-line"><span>身份</span><span class="chip chip-accent">${seatBound ? escapeHtml(`${seat.colorName ?? seat.name} · 棋手`) : '观战 · 公开视角'}</span><button class="btn btn-quiet btn-sm" type="button" data-action="open-dafeiyu-settings">${icon('settings', 'icon-sm')}</button></div>` : ''}
          ${busyMoving ? `<div class="chat-busy mt-8"><span class="spinner"></span>正在落子；点评已让位。</div>` : dafeiyu.busy ? `<div class="chat-busy mt-8"><span class="spinner"></span>正在组织一句${dafeiyu.autoComment ? '点评' : '回答'}…</div>` : ''}
        `}
      </div>
    </section>`;
}

function dafeiyuAskHint(match) {
  if (!match.dafeiyu?.enabled) return '邀请大肥鱼观战后，可以在这里手动提问。';
  if (match.dafeiyu.status !== 'connected') return '大肥鱼未连接，连接恢复后可以提问。';
  if (match.dafeiyu.askBlockedReason) return match.dafeiyu.askBlockedReason;
  return '';
}

function renderChatCard(match) {
  const canAsk = Boolean(match.controls?.canAskDafeiyu);
  const disabledReason = dafeiyuAskHint(match);
  const seat = dafeiyuSeatOf(match);
  const placeholder = canAsk
    ? (seat ? `问问${seat.colorName ?? seat.name}大肥鱼，例如：你现在还能怎么走？` : '问问大肥鱼，例如：黑棋现在有什么威胁？')
    : disabledReason;
  return `
    <section class="side-card chat-card" id="chat-card">
      <div class="side-card-head">
        <div class="side-card-title">${icon('message', 'icon-sm')} 对局聊天 <span class="chip" id="chat-count">${(match.chat ?? []).length}</span></div>
        <span id="chat-ready">${canAsk ? '<span class="chat-busy"><span class="dot dot-live"></span>可提问</span>' : '<span class="caption">文字区</span>'}</span>
      </div>
      <div class="chat-log" id="chat-log">${renderChatMessages(match, {
        emptyText: match.dafeiyu?.enabled ? '她还没有说话。等她看到关键局面，或在下面问她。' : '还没有公开对话。',
      })}</div>
      <form class="chat-form" data-form="chat" id="chat-form">
        <input
          class="input"
          id="chat-input"
          name="text"
          type="text"
          maxlength="500"
          autocomplete="off"
          placeholder="${escapeAttr(placeholder)}"
          value="${escapeAttr(state.chatDraft)}"
          ${canAsk && !state.askBusy ? '' : 'disabled'}
          aria-label="向大肥鱼提问"
        />
        <button class="btn btn-primary" type="submit" ${canAsk && !state.askBusy ? '' : 'disabled'}>
          ${state.askBusy ? '<span class="spinner"></span>' : icon('send')}
        </button>
      </form>
      <div class="chat-disabled" id="chat-disabled" ${canAsk ? 'hidden' : ''}>${escapeHtml(disabledReason)}</div>
    </section>
  `;
}

function renderControlsCard(match) {
  const controls = match.controls ?? {};
  const paused = match.status === 'paused';
  const terminal = match.status === 'finished' || match.status === 'aborted';
  const primaryPaused = controls.canRetry ? `
    <button class="btn btn-primary" type="button" data-action="retry-match" ${controls.canRetry ? '' : 'disabled'}>${icon('refresh', 'icon-sm')} 重试本手</button>
  ` : `
    <button class="btn btn-primary" type="button" data-action="resume-match" ${controls.canResume ? '' : 'disabled'}>${icon('play', 'icon-sm')} 继续</button>
  `;
  return `
    <section class="side-card controls-card">
      <div class="side-card-head">
        <div class="side-card-title">${icon('settings', 'icon-sm')} 对局控制</div>
        <span class="caption">${paused ? '暂停中' : terminal ? '已结束' : '进行中'}</span>
      </div>
      <div class="side-card-body">
        <div class="control-grid">
          ${terminal ? `
            <a class="btn btn-primary btn-wide" href="#/replay/${encodeURIComponent(match.id)}">${icon('history')} 查看回放</a>
            <a class="btn btn-quiet btn-sm" href="#/lobby">${icon('plus', 'icon-sm')} 再开一局</a>
          ` : paused ? `
            ${primaryPaused}
            ${controls.canStep ? `<button class="btn" type="button" data-action="step-match">${icon('step', 'icon-sm')} 单步</button>` : `<button class="btn" type="button" data-action="pause-match" disabled>${icon('pause', 'icon-sm')} 暂停</button>`}
            <button class="btn btn-danger btn-wide" type="button" data-action="end-match">${icon('flag', 'icon-sm')} 结束对局</button>
          ` : `
            <button class="btn btn-wide" type="button" data-action="pause-match">${icon('pause')} 暂停对局</button>
            <button class="btn btn-danger btn-wide" type="button" data-action="end-match">${icon('flag', 'icon-sm')} 结束对局</button>
          `}
        </div>
        ${paused && controls.canRetry ? `<p class="control-footnote">重试会清除暂停原因，并在当前回合重新请求 AI；迟到回复不会改变棋盘。</p>` : ''}
        ${!paused && !terminal && controls.allAi ? `<p class="control-footnote">全 AI 对局可暂停后单步推进。离开对局页会释放大肥鱼会话；有棋手座的棋局会暂停，回来后可重连接续。</p>` : ''}
        ${['dafeiyu_disconnected', 'page_left'].includes(match.pause?.code) ? `<div class="notice notice-warn mt-12">${icon('alert')}<span>${match.pause?.code === 'page_left' ? '已离开对局页，大肥鱼会话释放。返回后先重新连接，再按“继续”。' : '大肥鱼棋手掉线，重连成功后按“继续”恢复。'}</span></div>` : ''}
        ${(match.errors ?? []).length ? `
          <details class="rules-details">
            <summary>关键错误记录（${(match.errors ?? []).length}）</summary>
            <div class="error-list">
              ${(match.errors ?? []).slice(-4).reverse().map((error) => `<div class="error-entry"><span class="code">${escapeHtml(error.code)}</span><span>${escapeHtml(error.message)}</span></div>`).join('')}
            </div>
          </details>
        ` : ''}
        <details class="rules-details">
          <summary>逐手指标（耗时 / 尝试 / 失败类型）</summary>
          <div class="error-list">
            ${(match.actions ?? []).slice(-10).reverse().map((action) => `
              <div class="error-entry">
                <span class="code">#${action.index} ${escapeHtml(match.seats[action.seat]?.colorName ?? action.seat)}</span>
                <span>${escapeHtml(action.text ?? action.action?.move ?? action.action?.cell ?? '—')} · ${action.metrics?.elapsedMs ?? 0}ms · ${action.metrics?.attempts ?? 1} 次${(action.metrics?.failures ?? []).length ? ` · ${escapeHtml((action.metrics.failures ?? []).map((item) => item.code).join(', '))}` : ''}</span>
              </div>`).join('') || '<div class="caption">还没有动作。</div>'}
          </div>
        </details>
        <details class="rules-details">
          <summary>规则、版本与连接</summary>
          <pre>${escapeHtml((match.game?.rulesText ?? '').trim())}\n\n规则版本：${escapeHtml(match.rulesVersion)}\n对局编号：${escapeHtml(match.id)}\n座位顺序：${(match.seatOrder ?? []).map((id) => escapeHtml(match.seats[id]?.colorName ?? id)).join(' → ')}\n本机地址：${escapeHtml(window.location.origin)}</pre>
        </details>
      </div>
    </section>`;
}

function renderTopMatchControls(match) {
  const controls = match.controls ?? {};
  if (match.status === 'finished' || match.status === 'aborted') return '';
  if (match.status === 'paused') {
    if (controls.canRetry) {
      return `<button class="btn btn-sm btn-primary" type="button" data-action="retry-match">${icon('refresh', 'icon-sm')} 重试本手</button>`;
    }
    return `
      <button class="btn btn-sm btn-primary" type="button" data-action="resume-match" ${controls.canResume ? '' : 'disabled'}>${icon('play', 'icon-sm')} 继续</button>
      ${controls.canStep ? `<button class="btn btn-sm" type="button" data-action="step-match">${icon('step', 'icon-sm')} 单步</button>` : ''}
    `;
  }
  return `<button class="btn btn-sm" type="button" data-action="pause-match">${icon('pause', 'icon-sm')} 暂停</button>`;
}

function matchMetaHtml(match) {
  return `
    <span>${escapeHtml(match.id)}</span><span class="sep">/</span>
    <span>规则 v${escapeHtml(match.rulesVersion)}</span><span class="sep">/</span>
    <span>${formatDateTime(match.createdAt)}</span>
    ${state.sseState === 'reconnecting' ? '<span class="sep">/</span><span class="chip chip-danger js-sse-chip">实时连接重试中</span>' : ''}`;
}

function matchTitleChips(match) {
  return `
    ${statusPill(match.status)}
    ${match.dafeiyu?.enabled ? `<span class="chip chip-gold">${icon('spark', 'icon-sm')} ${match.dafeiyu.playerSeat ? '大肥鱼执棋' : '大肥鱼观战'}</span>` : ''}`;
}

function matchActionsHtml(match) {
  return `
    ${renderTopMatchControls(match)}
    <a class="btn btn-sm" href="/api/matches/${encodeURIComponent(match.id)}/export" download>${icon('download', 'icon-sm')} 导出记录</a>
    ${match.status === 'finished' || match.status === 'aborted' ? `<a class="btn btn-sm btn-gold" href="#/replay/${encodeURIComponent(match.id)}">${icon('history', 'icon-sm')} 回放</a>` : ''}`;
}

function syncChatForm(match) {
  const input = document.querySelector('#chat-input');
  if (!input || state.chatComposing) return;
  const canAsk = Boolean(match.controls?.canAskDafeiyu);
  const archived = Boolean(match.archived);
  const connected = match.dafeiyu?.enabled && match.dafeiyu?.status === 'connected';
  const editable = connected && !archived;
  const hint = dafeiyuAskHint(match);
  input.disabled = !editable;
  input.placeholder = canAsk
    ? (dafeiyuSeatOf(match)
      ? `问问${dafeiyuSeatOf(match).colorName ?? dafeiyuSeatOf(match).name}大肥鱼，例如：你现在还能怎么走？`
      : '问问大肥鱼，例如：黑棋现在有什么威胁？')
    : (hint || '暂时不能提问。');
  const button = document.querySelector('#chat-form button[type=submit]');
  if (button) {
    button.disabled = !canAsk || state.askBusy;
    button.innerHTML = state.askBusy ? '<span class="spinner"></span>' : icon('send');
  }
  const ready = document.querySelector('#chat-ready');
  if (ready) {
    ready.innerHTML = canAsk
      ? '<span class="chat-busy"><span class="dot dot-live"></span>可提问</span>'
      : `<span class="caption">${escapeHtml(hint.includes('落子') ? '落子中' : '暂不可问')}</span>`;
  }
  const disabled = document.querySelector('#chat-disabled');
  if (disabled) {
    disabled.hidden = canAsk;
    disabled.textContent = hint;
  }
}

function renderMatchPage() {
  const match = state.match;
  if (!match) return;
  const view = match.state;
  const canPlay = Boolean(match.controls?.isHumanTurn && !match.pending && match.status === 'playing' && !state.actionBusy);
  const humanSeat = Object.values(match.seats).find((seat) => seat.kind === 'human');
  const humanColor = match.controls?.humanSeat ?? humanSeat?.id ?? null;
  const content = `
    <div class="page match-page">
      <a class="back-link" href="#/history">${icon('arrowLeft')} 对局记录</a>
      <div class="match-topbar">
        <div>
          <div class="eyebrow" id="match-eyebrow">LIVE TABLE · ${escapeHtml(match.modeLabel ?? '')}</div>
          <div class="match-title-row">
            <h1 class="match-title">${escapeHtml(match.gameName)}</h1>
            <span id="match-title-chips">${matchTitleChips(match)}</span>
          </div>
          <div class="match-meta-line" id="match-meta">${matchMetaHtml(match)}</div>
        </div>
        <div class="match-actions" id="match-actions">${matchActionsHtml(match)}</div>
      </div>
      <div id="match-status">${matchStatusBanner(match)}</div>
      <div id="match-seats">${seatStrip(match, view)}</div>
      <div class="match-layout">
        <div id="match-surface">${renderGameSurface({ match, view, interactive: canPlay, humanColor, title: '对局桌面' })}</div>
        <div class="side-column">
          <div id="match-dafeiyu">${renderDafeiyuCard(match)}</div>
          ${renderChatCard(match)}
          <div id="match-controls">${renderControlsCard(match)}</div>
        </div>
      </div>
    </div>`;
  state.matchShellId = match.id;
  renderShell(content, 'lobby');
  syncChatForm(match);
  requestAnimationFrame(() => {
    const log = document.querySelector('#chat-log');
    if (log) log.scrollTop = log.scrollHeight;
    updateSseChip();
  });
}

function updateMatchView() {
  const match = state.match;
  if (!match || !routeIs('match', match.id)) return;
  if (state.chatComposing) {
    state.pendingMatchUpdate = true;
    return;
  }
  if (!document.querySelector('#match-status')) {
    renderMatchPage();
    return;
  }
  const focused = document.activeElement;
  const focusedCoord = focused?.dataset?.coord ?? null;
  const focusedCell = focused?.dataset?.cell ?? null;
  const chatLog = document.querySelector('#chat-log');
  const chatAtBottom = !chatLog || chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 48;
  const previousChatScroll = chatLog?.scrollTop ?? 0;
  const view = match.state;
  const canPlay = Boolean(match.controls?.isHumanTurn && !match.pending && match.status === 'playing' && !state.actionBusy);

  const set = (selector, html) => {
    const element = document.querySelector(selector);
    if (element) element.innerHTML = html;
  };
  set('#match-eyebrow', `LIVE TABLE · ${escapeHtml(match.modeLabel ?? '')}`);
  set('#match-title-chips', matchTitleChips(match));
  set('#match-meta', matchMetaHtml(match));
  set('#match-actions', matchActionsHtml(match));
  set('#match-status', matchStatusBanner(match));
  set('#match-seats', seatStrip(match, view));
  set('#match-surface', renderGameSurface({ match, view, interactive: canPlay, humanColor: match.controls?.humanSeat ?? null, title: '对局桌面' }));
  set('#match-dafeiyu', renderDafeiyuCard(match));
  set('#match-controls', renderControlsCard(match));
  const count = document.querySelector('#chat-count');
  if (count) count.textContent = String((match.chat ?? []).length);
  const log = document.querySelector('#chat-log');
  if (log) log.innerHTML = renderChatMessages(match, {
    emptyText: match.dafeiyu?.enabled ? '她还没有说话。等她看到关键局面，或在下面问她。' : '还没有公开对话。',
  });
  syncChatForm(match);
  if (log) log.scrollTop = chatAtBottom ? log.scrollHeight : previousChatScroll;
  if (focusedCoord) {
    const next = document.querySelector(`[data-coord="${CSS.escape(focusedCoord)}"]`);
    if (next && !next.disabled) next.focus();
    else document.querySelector('.board-surface')?.focus();
  } else if (focusedCell) {
    const next = document.querySelector(`[data-cell="${CSS.escape(focusedCell)}"]`);
    if (next && !next.disabled) next.focus();
    else document.querySelector('.three-seat-grid')?.focus();
  }
  updateSseChip();
}

function openMatchStream(id) {
  closeMatchStream();
  state.sseState = 'connecting';
  const source = new EventSource(`/api/matches/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  source.addEventListener('match', (event) => {
    if (!state.match || state.match.id !== id) return;
    try {
      const match = JSON.parse(event.data);
      if (!mergeMatchSnapshot(match)) return;
      if (routeIs('match', id)) {
        updateMatchView();
      }
    } catch (error) {
      console.error('SSE 消息解析失败', error);
    }
  });
  source.onopen = () => {
    state.sseState = 'open';
    updateSseChip();
  };
  source.onerror = () => {
    state.sseState = 'reconnecting';
    updateSseChip();
  };
}

function updateSseChip() {
  const meta = document.querySelector('.match-meta-line');
  if (!meta || !state.match) return;
  const existing = meta.querySelector('.js-sse-chip');
  if (state.sseState === 'reconnecting' && !existing) {
    const span = document.createElement('span');
    span.className = 'chip chip-danger js-sse-chip';
    span.textContent = '实时连接重试中';
    meta.append(span);
  } else if (state.sseState === 'open' && existing) {
    existing.remove();
  }
}

function closeMatchStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.sseState = null;
}

function releaseMatchSession(matchId, reason = '离开对局页面') {
  if (!matchId) return;
  const payload = JSON.stringify({ reason });
  try {
    const sent = navigator.sendBeacon?.(
      `/api/matches/${encodeURIComponent(matchId)}/leave`,
      new Blob([payload], { type: 'application/json' }),
    );
    if (sent) return;
  } catch {
    // 回退到 fetch keepalive。
  }
  void fetch(`/api/matches/${encodeURIComponent(matchId)}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function renderReplayPage() {
  const replay = state.replay;
  if (!replay) return;
  const step = Math.max(0, Math.min(state.replayStep, replay.totalSteps));
  state.replayStep = step;
  const current = replay.steps[step];
  const view = current.view;
  const match = replay.match;
  const chat = (replay.chat ?? []).filter((item) => (item.step ?? 0) <= step);
  const finalOutcome = replay.steps.at(-1)?.view?.outcome;
  const currentOutcome = view.outcome;
  const currentMove = current.action;
  const content = `
    <div class="page replay-page">
      <a class="back-link" href="#/history">${icon('arrowLeft')} 对局记录</a>
      <div class="match-topbar">
        <div>
          <div class="eyebrow">REPLAY · READ ONLY</div>
          <div class="match-title-row">
            <h1 class="match-title">${escapeHtml(match.gameName)} · 回放</h1>
            <span class="chip chip-gold">${escapeHtml(replay.resultLabel ?? '已结束')}</span>
          </div>
          <div class="match-meta-line">
            <span>${escapeHtml(match.id)}</span><span class="sep">/</span>
            <span>规则 v${escapeHtml(match.rulesVersion)}</span><span class="sep">/</span>
            <span>共 ${replay.totalSteps} 手</span>
            <span class="sep">/</span>
            <span>权威快照 · 不调用模型</span>
          </div>
        </div>
        <div class="match-actions">
          <a class="btn btn-sm" href="/api/matches/${encodeURIComponent(match.id)}/export" download>${icon('download', 'icon-sm')} 导出记录</a>
          <a class="btn btn-sm btn-primary" href="#/lobby">${icon('plus', 'icon-sm')} 新对局</a>
        </div>
      </div>
      ${currentOutcome ? `
        <div class="match-status-banner finished">
          <div class="match-status-icon">${icon('flag')}</div>
          <div class="match-status-copy">
            <div class="match-status-title">${escapeHtml(replay.resultLabel ?? '对局结束')}</div>
            <div class="match-status-desc">${currentOutcome.type === 'win' ? `获胜${currentOutcome.length ? `连线 ${currentOutcome.length} 子` : `落点 ${currentOutcome.move ?? currentOutcome.cell ?? '—'}`}。` : currentOutcome.type === 'draw' ? '规则判定和棋。' : escapeHtml(currentOutcome.reason ?? '对局中止。')}</div>
          </div>
          <div class="match-status-side"><span class="chip">${step} / ${replay.totalSteps} 手</span></div>
        </div>` : `
        <div class="match-status-banner">
          <div class="match-status-icon">${icon('history')}</div>
          <div class="match-status-copy">
            <div class="match-status-title">正在复盘第 ${step} 手${step === 0 ? ' · 初始局面' : ''}</div>
            <div class="match-status-desc">${step === 0 ? '尚未落子。按“下一手”开始；可拖拽时间轴跳到任意回合。' : `上一手：${escapeHtml(current.actionText ?? currentMove?.move ?? currentMove?.cell ?? '—')} · ${escapeHtml(match.seats[current.seat]?.colorName ?? match.seats[current.seat]?.name ?? '')}`}</div>
          </div>
          <div class="match-status-side"><span class="chip">${step} / ${replay.totalSteps} 手</span></div>
        </div>`}
      ${seatStrip(match, view)}
      <section class="card replay-toolbar">
        <div class="replay-progress">
          <span>时间轴</span>
          <input class="step-range" type="range" min="0" max="${replay.totalSteps}" value="${step}" data-change="replay-range" aria-label="回放进度" />
          <span class="mono">${step}/${replay.totalSteps}</span>
        </div>
        <div class="replay-buttons">
          <button class="btn btn-sm" type="button" data-action="replay-prev" ${step <= 0 ? 'disabled' : ''}>${icon('arrowLeft', 'icon-sm')} 上一手</button>
          <button class="btn btn-sm" type="button" data-action="replay-first" ${step <= 0 ? 'disabled' : ''}>初始</button>
          <form class="step-jump" data-form="replay-jump">
            <label class="sr-only" for="replay-step-input">跳到第几手</label>
            <input class="input" id="replay-step-input" name="step" type="number" min="0" max="${replay.totalSteps}" value="${step}" />
            <button class="btn btn-sm" type="submit">跳转</button>
          </form>
          <button class="btn btn-sm btn-primary" type="button" data-action="replay-next" ${step >= replay.totalSteps ? 'disabled' : ''}>下一手 ${icon('arrowRight', 'icon-sm')}</button>
          <button class="btn btn-sm" type="button" data-action="replay-last" ${step >= replay.totalSteps ? 'disabled' : ''}>终局</button>
        </div>
      </section>
      <div class="replay-layout">
        <div>
          ${renderGameSurface({ match, view, interactive: false, humanColor: null, title: '历史棋盘' })}
        </div>
        <aside class="replay-side">
          <section class="side-card replay-chat">
            <div class="side-card-head">
              <div class="side-card-title">${icon('message', 'icon-sm')} 当场公开发言</div>
              <span class="chip">截至第 ${step} 手</span>
            </div>
            <div class="chat-log">${renderChatMessages(match, { chat, emptyText: '这一阶段没有公开发言。' })}</div>
          </section>
          <section class="card replay-info">
            <h3>这一局</h3>
            <p>${escapeHtml(replay.modeLabel ?? '')}<br />${formatFullDate(match.createdAt)} · 规则 v${escapeHtml(match.rulesVersion)}<br />最终结果：${escapeHtml(replay.resultLabel ?? '—')}</p>
            <div class="replay-outcome">
              ${icon(finalOutcome?.type === 'win' ? 'flag' : 'history')}
              <div>
                <strong>${escapeHtml(replay.resultLabel ?? '对局结束')}</strong>
                <small>${escapeHtml(step === replay.totalSteps ? '当前在终局' : '按“终局”跳到最后一手')}</small>
              </div>
            </div>
            ${replay.chat?.some((item) => item.kind === 'comment') ? `<p class="caption mt-12">本局含大肥鱼的公开点评。回放不会重新请求模型或播放语音。</p>` : ''}
          </section>
        </aside>
      </div>
    </div>`;
  renderShell(content, 'history');
  requestAnimationFrame(() => {
    const log = document.querySelector('.replay-chat .chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  });
}

function setReplayStep(value) {
  if (!state.replay) return;
  const step = Math.max(0, Math.min(Number(value) || 0, state.replay.totalSteps));
  state.replayStep = step;
  renderReplayPage();
}

function openModal(html) {
  state.modalOpen = true;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop">${html}</div>`;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const first = modalRoot.querySelector('input:not([type=hidden]), select, textarea, button');
    first?.focus();
  });
}

function closeModal() {
  const resolver = state.modalResolve;
  state.modalResolve = null;
  state.modalOpen = false;
  modalRoot.innerHTML = '';
  document.body.style.overflow = '';
  resolver?.(false);
}

function resolveModal(value) {
  const resolver = state.modalResolve;
  state.modalResolve = null;
  state.modalOpen = false;
  modalRoot.innerHTML = '';
  document.body.style.overflow = '';
  resolver?.(value);
}

function confirmDialog({ title, message, confirmLabel = '确认', danger = false, extra = '' }) {
  return new Promise((resolve) => {
    state.modalResolve = resolve;
    openModal(`
      <div class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-head">
          <div>
            <h2 class="modal-title" id="confirm-title">${escapeHtml(title)}</h2>
            <p class="modal-sub">${escapeHtml(message)}</p>
          </div>
          <button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${danger ? `<div class="modal-danger-icon">${icon('alert')}</div>` : ''}
          ${extra}
          <div class="form-actions">
            <button class="btn btn-quiet" type="button" data-action="close-modal">取消</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-action="confirm-dialog">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>`);
  });
}

function modelFormHtml(model = null) {
  const providers = state.boot?.providers ?? [];
  return `
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="model-modal-title">
        <div class="modal-head">
          <div>
            <h2 class="modal-title" id="model-modal-title">${model ? '编辑模型' : '新增模型'}</h2>
            <p class="modal-sub">填写 OpenAI 兼容接口。Base URL 可以包含 /v1，也可以不包含；Key 留空表示无需认证。</p>
          </div>
          <button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <form data-form="model" data-model-id="${escapeAttr(model?.id ?? '')}">
            <div class="form-grid">
              <label class="field span-2">
                <span class="field-label">显示名称 <span class="field-required">*</span></span>
                <input class="input" name="name" required maxlength="80" value="${escapeAttr(model?.name ?? '')}" placeholder="例如：本机 KVMem / DeepSeek" autocomplete="off" />
              </label>
              <label class="field">
                <span class="field-label">接口类型</span>
                <select class="select" name="provider">
                  ${providers.map((provider) => `<option value="${escapeAttr(provider.id)}" ${model?.provider === provider.id || (!model && provider.id === 'openai-compatible') ? 'selected' : ''}>${escapeHtml(provider.label)}</option>`).join('')}
                </select>
              </label>
              <label class="field">
                <span class="field-label">超时（毫秒）</span>
                <input class="input input-mono" name="timeoutMs" type="number" min="1000" max="600000" step="1000" value="${escapeAttr(model?.timeoutMs ?? 120000)}" />
              </label>
              <label class="field span-2">
                <span class="field-label">Base URL <span class="field-required">*</span></span>
                <input class="input input-mono" name="baseUrl" required value="${escapeAttr(model?.baseUrl ?? 'http://127.0.0.1:18200/v1')}" placeholder="http://127.0.0.1:18200/v1" spellcheck="false" autocomplete="off" />
                <span class="field-hint">会自动处理末尾斜杠与 /v1；也可以粘贴完整的 /chat/completions 地址。</span>
              </label>
              <label class="field">
                <span class="field-label">Model ID <span class="field-required">*</span></span>
                <input class="input input-mono" name="modelId" required value="${escapeAttr(model?.modelId ?? 'kvmem-polystrata-qwen35')}" placeholder="模型或部署的 ID" spellcheck="false" autocomplete="off" />
              </label>
              <label class="field">
                <span class="field-label">API Key ${model?.hasApiKey ? '<span class="field-hint">已设置</span>' : '<span class="field-hint">可留空</span>'}</span>
                <input class="input input-mono" name="apiKey" type="password" value="" placeholder="${model?.hasApiKey ? '已保存，留空则保留' : '无 Key 服务可留空'}" autocomplete="new-password" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">非法动作重试次数</span>
                <input class="input input-mono" name="maxRetries" type="number" min="0" max="5" step="1" value="${escapeAttr(model?.maxRetries ?? 2)}" />
              </label>
              <div class="span-2">
                ${model?.hasApiKey ? `<label class="checkline"><input type="checkbox" name="clearKey" /> 清除已保存的 API Key（保存后不再发送 Authorization）</label>` : ''}
                <label class="checkline mt-8"><input type="checkbox" name="isExample" ${model?.isExample ? 'checked' : ''} /> 标记为示例配置（仅界面提示，不影响调用）</label>
              </div>
            </div>
            <div class="notice notice-info mt-16">${icon('shield')}<span>保存后 Key 只写入本机 <code>data/arena.json</code>；读取接口只返回是否已设置。测试连接会由后端直接请求模型。</span></div>
            <div id="draft-test-result" class="test-result-panel"></div>
            <div class="form-actions">
              <button class="btn btn-quiet left" type="button" data-action="test-draft">${icon('plug', 'icon-sm')} 测试当前填写</button>
              <button class="btn btn-quiet" type="button" data-action="close-modal">取消</button>
              <button class="btn btn-primary" type="submit">${icon('check')} 保存配置</button>
            </div>
          </form>
        </div>
      </div>`;
}

function openModelForm(model = null) {
  state.modalResolve = null;
  openModal(modelFormHtml(model));
}

function dafeiyuFormHtml(config) {
  return `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dafeiyu-modal-title">
        <div class="modal-head">
          <div>
            <h2 class="modal-title" id="dafeiyu-modal-title">大肥鱼连接</h2>
            <p class="modal-sub">竞技场通过本机 HTTP 接口连接实际的桌宠服务。修改后需要重连当前对局才会使用新配置。</p>
          </div>
          <button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <form data-form="dafeiyu">
            <div class="form-grid">
              <label class="field span-2">
                <span class="field-label">桌宠服务地址 <span class="field-required">*</span></span>
                <input class="input input-mono" name="bridgeUrl" required value="${escapeAttr(config?.bridgeUrl ?? 'http://127.0.0.1:12393')}" placeholder="http://127.0.0.1:12393" spellcheck="false" />
                <span class="field-hint">桌宠运行中的后端根地址，不要填 /api/game/arena。</span>
              </label>
              <label class="field">
                <span class="field-label">Arena API 路径</span>
                <input class="input input-mono" name="apiBase" value="${escapeAttr(config?.apiBase ?? '/api/game/arena')}" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">请求超时（毫秒）</span>
                <input class="input input-mono" name="timeoutMs" type="number" min="1000" max="600000" value="${escapeAttr(config?.timeoutMs ?? 90000)}" />
              </label>
              <label class="field">
                <span class="field-label">接入令牌 ${config?.hasToken ? '<span class="field-hint">已设置</span>' : '<span class="field-hint">可留空</span>'}</span>
                <input class="input input-mono" name="token" type="password" value="" placeholder="${config?.hasToken ? '已保存，留空则保留' : '本机默认无需令牌'}" autocomplete="new-password" spellcheck="false" />
              </label>
              <label class="field">
                <span class="field-label">请求 Origin</span>
                <input class="input input-mono" name="origin" value="${escapeAttr(config?.origin ?? '')}" placeholder="留空使用竞技场监听地址" spellcheck="false" />
              </label>
              <div class="span-2">
                ${config?.hasToken ? `<label class="checkline"><input type="checkbox" name="clearToken" /> 清除已保存的桌宠接入令牌</label>` : ''}
              </div>
            </div>
            <div class="notice notice-warn mt-16">${icon('info')}<span>桌宠需要安装包含 <code>arena_routes.py</code> 的桥接版本，并在其本机配置中允许竞技场地址。具体见仓库 <code>docs/dafeiyu.md</code>。</span></div>
            <div class="form-actions">
              <button class="btn btn-quiet left" type="button" data-action="check-health">${icon('plug', 'icon-sm')} 检测桌宠</button>
              <button class="btn btn-quiet" type="button" data-action="close-modal">取消</button>
              <button class="btn btn-primary" type="submit">${icon('check')} 保存连接</button>
            </div>
          </form>
        </div>
      </div>`;
}

function openDafeiyuForm() {
  state.modalResolve = null;
  openModal(dafeiyuFormHtml(state.dafeiyu ?? state.boot?.dafeiyu ?? {}));
}

function collectModelForm(form) {
  const data = new FormData(form);
  const modelId = form.dataset.modelId || null;
  const body = {
    name: String(data.get('name') ?? '').trim(),
    provider: String(data.get('provider') ?? 'openai-compatible'),
    baseUrl: String(data.get('baseUrl') ?? '').trim(),
    modelId: String(data.get('modelId') ?? '').trim(),
    timeoutMs: Number(data.get('timeoutMs')),
    maxRetries: Number(data.get('maxRetries')),
    isExample: data.get('isExample') === 'on',
  };
  const keyValue = String(data.get('apiKey') ?? '');
  if (data.get('clearKey') === 'on') body.apiKey = '';
  else if (keyValue) body.apiKey = keyValue;
  else if (!modelId) body.apiKey = '';
  return { body, modelId };
}

async function saveModel(form) {
  const { body, modelId } = collectModelForm(form);
  if (!body.name) {
    toast('显示名称不能为空。', 'error');
    return;
  }
  if (modelId) {
    await api(`/api/models/${encodeURIComponent(modelId)}`, { method: 'PUT', body });
    toast('模型配置已保存。', 'success');
  } else {
    await api('/api/models', { method: 'POST', body });
    toast('模型配置已新增。', 'success');
  }
  await loadModelsData();
  closeModal();
  if (routeIs('models')) renderModels();
}

async function draftTestModel(button) {
  const form = button.closest('form');
  if (!form) return;
  const { body, modelId } = collectModelForm(form);
  const resultBox = document.querySelector('#draft-test-result');
  if (resultBox) resultBox.innerHTML = renderTestResult(null, { loading: true });
  setButtonBusy(button, true);
  try {
    if (modelId) body.id = modelId;
    const result = await api('/api/models/test', { method: 'POST', body });
    if (resultBox) resultBox.innerHTML = renderTestResult(result, { title: result.ok ? '连接成功' : '连接失败' });
  } catch (error) {
    if (resultBox) resultBox.innerHTML = `<div class="model-test-result fail"><div class="test-summary fail">${icon('alert')}<span>测试请求失败</span></div><p>${escapeHtml(error.message)}</p></div>`;
  } finally {
    setButtonBusy(button, false);
  }
}

async function testModelSaved(id) {
  state.modelTests[id] = { loading: true, result: null };
  if (routeIs('models')) renderModels();
  try {
    const result = await api(`/api/models/${encodeURIComponent(id)}/test`, { method: 'POST' });
    state.modelTests[id] = { loading: false, result };
  } catch (error) {
    state.modelTests[id] = {
      loading: false,
      result: {
        ok: false,
        error: { message: error.message },
        checks: [{ name: '请求', ok: false, detail: error.message }],
      },
    };
  }
  if (routeIs('models')) renderModels();
}

async function saveDafeiyu(form) {
  const data = new FormData(form);
  const body = {
    bridgeUrl: String(data.get('bridgeUrl') ?? '').trim(),
    apiBase: String(data.get('apiBase') ?? '/api/game/arena').trim(),
    timeoutMs: Number(data.get('timeoutMs')),
    origin: String(data.get('origin') ?? '').trim(),
  };
  const token = String(data.get('token') ?? '');
  if (token) body.token = token;
  if (data.get('clearToken') === 'on') body.clearToken = true;
  const result = await api('/api/dafeiyu/config', { method: 'PUT', body });
  state.dafeiyu = result.dafeiyu;
  if (state.boot) state.boot.dafeiyu = result.dafeiyu;
  closeModal();
  toast('大肥鱼连接配置已保存。当前对局需要重连后生效。', 'success');
  if (state.route?.name === 'models') renderModels();
  if (state.route?.name === 'lobby') renderLobby();
  void refreshHealth(true);
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.classList.toggle('is-loading', busy);
  if (busy) {
    button.dataset.wasDisabled = button.disabled ? '1' : '';
    button.disabled = true;
  } else {
    button.disabled = button.dataset.wasDisabled === '1';
    delete button.dataset.wasDisabled;
  }
}

async function startMatch({ quick = false } = {}) {
  const game = ensureLobbyGame(state.lobby.gameId, { quick });
  if (!game) {
    toast('没有可用的桌游。', 'error');
    return;
  }
  if (quick) state.lobby.observer = false;
  const errors = validateLobby();
  if (errors.length) {
    toast(errors[0], 'error');
    return;
  }
  const hasSeat = lobbyHasDafeiyuSeat();
  const seats = {};
  for (const def of orderedSeatDefs(game)) {
    const seat = lobbySeats()[def.id];
    const input = { kind: seat.kind };
    if (seat.kind === 'model') {
      input.modelId = seat.modelId;
      input.moveMode = seat.moveMode;
    }
    if (seat.kind === 'dafeiyu') input.moveMode = seat.moveMode;
    seats[def.id] = input;
  }
  const payload = {
    gameId: game.id,
    seats,
    dafeiyu: {
      enabled: state.lobby.observer || hasSeat,
      autoComment: state.lobby.autoComment,
      voice: state.lobby.voice,
    },
  };
  const button = document.querySelector('[data-action="start-match"]');
  setButtonBusy(button, true);
  try {
    const result = await api('/api/matches', { method: 'POST', body: payload });
    state.chatDraft = '';
    state.match = result.match;
    navigate(`#/match/${encodeURIComponent(result.match.id)}`);
    toast('对局已开始。', 'success');
  } catch (error) {
    showError(error);
  } finally {
    if (document.contains(button)) setButtonBusy(button, false);
  }
}

async function submitAction(action) {
  if (state.actionBusy || !state.match) return;
  if (!state.match.controls?.isHumanTurn || state.match.status !== 'playing') return;
  const matchId = state.match.id;
  state.actionBusy = true;
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/actions`, {
      method: 'POST',
      body: {
        seat: state.match.controls.humanSeat,
        action,
        clientActionId: crypto.randomUUID(),
      },
    });
    mergeMatchSnapshot(result.match);
  } catch (error) {
    showError(error);
    try {
      const data = await api(`/api/matches/${encodeURIComponent(matchId)}`);
      mergeMatchSnapshot(data.match);
    } catch {
      // 保留当前界面，错误已经提示。
    }
  } finally {
    state.actionBusy = false;
    if (routeIs('match', matchId)) updateMatchView();
  }
}

function submitMove(coord) {
  return submitAction({ type: 'place', move: coord });
}

async function refreshCurrentMatch() {
  if (!state.match) return;
  const matchId = state.match.id;
  try {
    const data = await api(`/api/matches/${encodeURIComponent(matchId)}`);
    applyLiveMatch(data.match, matchId);
  } catch {
    // SSE 或下次操作会继续尝试。
  }
}

async function matchControl(action, button) {
  if (!state.match) return;
  const matchId = state.match.id;
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/${action}`, {
      method: 'POST',
      body: {},
    });
    applyLiveMatch(result.match, matchId);
    toast(action === 'pause' ? '已暂停。' : action === 'resume' ? '已继续。' : action === 'step' ? '已推进一步。' : '操作完成。', 'success');
  } catch (error) {
    showError(error);
    await refreshCurrentMatch();
  } finally {
    if (document.contains(button)) setButtonBusy(button, false);
  }
}

async function endCurrentMatch(button) {
  if (!state.match) return;
  const matchId = state.match.id;
  const confirmed = await confirmDialog({
    title: '结束这局对局？',
    message: '对局会标记为已中止并保存当前棋谱与聊天记录，之后仍可在历史页查看回放。',
    confirmLabel: '结束对局',
    danger: true,
  });
  if (!confirmed) return;
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/end`, {
      method: 'POST',
      body: { reason: '用户手动结束对局' },
    });
    applyLiveMatch(result.match, matchId);
    toast('对局已结束。', 'success');
  } catch (error) {
    showError(error);
    await refreshCurrentMatch();
  } finally {
    if (document.contains(button)) setButtonBusy(button, false);
  }
}

async function patchCurrentDafeiyu(patch, { button = null } = {}) {
  if (!state.match) return;
  const matchId = state.match.id;
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/dafeiyu`, {
      method: 'PATCH',
      body: patch,
    });
    applyLiveMatch(result.match, matchId);
    if (patch.enabled === true) toast('正在连接大肥鱼…', 'info');
    if (patch.enabled === false) toast('已关闭这局的大肥鱼观战。', 'success');
  } catch (error) {
    showError(error);
    await refreshCurrentMatch();
  } finally {
    if (document.contains(button)) setButtonBusy(button, false);
  }
}

async function reconnectDafeiyu(button) {
  if (!state.match) return;
  const matchId = state.match.id;
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/dafeiyu/reconnect`, {
      method: 'POST',
      body: {},
    });
    applyLiveMatch(result.match, matchId);
    toast('大肥鱼已重新连接。按“继续”恢复棋局。', 'success');
  } catch (error) {
    showError(error);
    await refreshCurrentMatch();
  } finally {
    if (document.contains(button)) setButtonBusy(button, false);
  }
}

async function askDafeiyu(form) {
  if (!state.match || state.askBusy) return;
  if (!state.match.controls?.canAskDafeiyu) {
    toast(dafeiyuAskHint(state.match) || '现在先不要提问。', 'info');
    return;
  }
  const input = form.querySelector('#chat-input');
  const question = input?.value.trim() ?? '';
  if (!question) {
    toast('先写下要问大肥鱼的问题。', 'error');
    return;
  }
  const button = form.querySelector('button[type=submit]');
  const matchId = state.match.id;
  state.askBusy = true;
  state.chatDraft = '';
  if (input) input.value = '';
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/matches/${encodeURIComponent(matchId)}/chat`, {
      method: 'POST',
      body: { text: question },
    });
    mergeMatchSnapshot(result.match);
  } catch (error) {
    showError(error);
    state.chatDraft = '';
    try {
      const data = await api(`/api/matches/${encodeURIComponent(matchId)}`);
      mergeMatchSnapshot(data.match);
    } catch {
      // 保留当前界面。
    }
  } finally {
    state.askBusy = false;
    if (document.contains(button)) setButtonBusy(button, false);
    if (routeIs('match', matchId)) {
      updateMatchView();
      const liveInput = document.querySelector('#chat-input');
      if (liveInput && !liveInput.disabled) {
        liveInput.focus();
        liveInput.setSelectionRange?.(liveInput.value.length, liveInput.value.length);
      }
    }
  }
}

async function openReplayFromHistory(id) {
  navigate(`#/replay/${encodeURIComponent(id)}`);
}

async function applyHistoryFilters(form) {
  const data = new FormData(form);
  state.historyFilters = {
    player: String(data.get('player') ?? '').trim(),
    result: String(data.get('result') ?? ''),
    status: String(data.get('status') ?? ''),
    game: String(data.get('game') ?? ''),
    q: String(data.get('q') ?? '').trim(),
  };
  const button = form.querySelector('button[type=submit]');
  setButtonBusy(button, true);
  try {
    await loadHistory();
    if (routeIs('history')) renderHistory();
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshHistory(button) {
  setButtonBusy(button, true);
  try {
    await loadHistory();
    if (routeIs('history')) renderHistory();
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshModels(button) {
  setButtonBusy(button, true);
  try {
    await loadModelsData();
    if (routeIs('models')) renderModels();
    toast('模型列表已刷新。', 'success');
  } catch (error) {
    showError(error);
  } finally {
    setButtonBusy(button, false);
  }
}

function deleteModel(modelId, button) {
  const model = modelFor(modelId);
  if (!model) return;
  confirmDialog({
    title: '删除模型配置？',
    message: `「${model.name}」将从本机配置中删除。已经进行中的对局使用启动时的快照，不会受到影响。`,
    confirmLabel: '删除',
    danger: true,
  }).then(async (confirmed) => {
    if (!confirmed) return;
    setButtonBusy(button, true);
    try {
      await api(`/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
      await loadModelsData();
      if (routeIs('models')) renderModels();
      toast('模型配置已删除。', 'success');
    } catch (error) {
      showError(error);
    } finally {
      if (document.contains(button)) setButtonBusy(button, false);
    }
  });
}

async function handleClick(event) {
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  const action = actionElement.dataset.action;
  if (action === 'modal-backdrop') {
    if (event.target === actionElement) closeModal();
    return;
  }
  if (action === 'close-modal') {
    closeModal();
    return;
  }
  if (action !== 'play-move' && action !== 'modal-backdrop') {
    event.preventDefault();
  }
  switch (action) {
    case 'reload-page':
      window.location.reload();
      break;
    case 'start-match':
      await startMatch();
      break;
    case 'quick-demo':
      await startMatch({ quick: true });
      break;
    case 'select-game':
      state.lobby.gameId = actionElement.dataset.game;
      ensureLobbyGame(state.lobby.gameId);
      renderLobby();
      break;
    case 'check-health':
      setButtonBusy(actionElement, true);
      await refreshHealth(true);
      setButtonBusy(actionElement, false);
      toast(state.health?.online ? '大肥鱼桌宠在线。' : (state.health?.message ?? '桌宠离线。'), state.health?.online ? 'success' : 'error');
      break;
    case 'open-dafeiyu-settings':
      openDafeiyuForm();
      break;
    case 'create-model':
      openModelForm();
      break;
    case 'edit-model': {
      const model = modelFor(actionElement.dataset.id);
      if (model) openModelForm(model);
      break;
    }
    case 'test-model':
      await testModelSaved(actionElement.dataset.id);
      break;
    case 'delete-model':
      deleteModel(actionElement.dataset.id, actionElement);
      break;
    case 'refresh-models':
      await refreshModels(actionElement);
      break;
    case 'test-draft':
      await draftTestModel(actionElement);
      break;
    case 'refresh-history':
      await refreshHistory(actionElement);
      break;
    case 'clear-history-filters':
      state.historyFilters = { player: '', result: '', status: '', game: '', q: '' };
      try {
        await loadHistory();
        if (routeIs('history')) renderHistory();
      } catch (error) {
        showError(error);
      }
      break;
    case 'open-replay':
      await openReplayFromHistory(actionElement.dataset.id);
      break;
    case 'open-match':
      navigate(`#/match/${encodeURIComponent(actionElement.dataset.id)}`);
      break;
    case 'play-move':
      await submitMove(actionElement.dataset.coord);
      break;
    case 'play-cell':
      await submitAction({ cell: Number(actionElement.dataset.cell) });
      break;
    case 'pause-match':
      await matchControl('pause', actionElement);
      break;
    case 'resume-match':
      await matchControl('resume', actionElement);
      break;
    case 'step-match':
      await matchControl('step', actionElement);
      break;
    case 'retry-match':
      await matchControl('retry', actionElement);
      break;
    case 'end-match':
      await endCurrentMatch(actionElement);
      break;
    case 'invite-dafeiyu':
      await patchCurrentDafeiyu({ enabled: true }, { button: actionElement });
      break;
    case 'stop-observer':
      await patchCurrentDafeiyu({ enabled: false }, { button: actionElement });
      break;
    case 'reconnect-dafeiyu':
      await reconnectDafeiyu(actionElement);
      break;
    case 'confirm-dialog':
      resolveModal(true);
      break;
    case 'replay-prev':
      setReplayStep(state.replayStep - 1);
      break;
    case 'replay-next':
      setReplayStep(state.replayStep + 1);
      break;
    case 'replay-first':
      setReplayStep(0);
      break;
    case 'replay-last':
      setReplayStep(state.replay?.totalSteps ?? 0);
      break;
    default:
      break;
  }
}

async function handleChange(event) {
  const target = event.target;
  const change = target.dataset.change;
  if (!change) return;
  if (change === 'seat-kind') {
    const seatId = target.dataset.seat;
    const seat = lobbySeats()[seatId];
    if (!seat) return;
    seat.kind = target.value;
    if (target.value === 'model' && !seat.modelId) {
      seat.modelId = state.models[0]?.id ?? '';
    }
    if (target.value === 'dafeiyu') state.lobby.autoComment = true;
    if (!seat.moveMode) seat.moveMode = 'assisted';
    renderLobby();
    return;
  }
  if (change === 'seat-model') {
    const seat = lobbySeats()[target.dataset.seat];
    if (seat) seat.modelId = target.value;
    renderLobby();
    return;
  }
  if (change === 'seat-mode') {
    const seat = lobbySeats()[target.dataset.seat];
    if (seat) seat.moveMode = target.value;
    renderLobby();
    return;
  }
  if (change === 'select-game') {
    state.lobby.gameId = target.value;
    ensureLobbyGame(state.lobby.gameId);
    renderLobby();
    return;
  }
  if (change === 'lobby-observer') {
    state.lobby.observer = target.checked;
    renderLobby();
    return;
  }
  if (change === 'lobby-auto') {
    state.lobby.autoComment = target.checked;
    return;
  }
  if (change === 'lobby-voice') {
    state.lobby.voice = target.checked;
    return;
  }
  if (change === 'match-auto') {
    await patchCurrentDafeiyu({ autoComment: target.checked });
    return;
  }
  if (change === 'match-voice') {
    await patchCurrentDafeiyu({ voice: target.checked });
    return;
  }
  if (change === 'replay-range') {
    setReplayStep(Number(target.value));
    return;
  }
}

async function handleSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const type = form.dataset.form;
  try {
    if (type === 'model') {
      const button = form.querySelector('button[type=submit]');
      setButtonBusy(button, true);
      try {
        await saveModel(form);
      } finally {
        setButtonBusy(button, false);
      }
    } else if (type === 'dafeiyu') {
      const button = form.querySelector('button[type=submit]');
      setButtonBusy(button, true);
      try {
        await saveDafeiyu(form);
      } finally {
        setButtonBusy(button, false);
      }
    } else if (type === 'history') {
      await applyHistoryFilters(form);
    } else if (type === 'chat') {
      await askDafeiyu(form);
    } else if (type === 'replay-jump') {
      const data = new FormData(form);
      setReplayStep(data.get('step'));
    }
  } catch (error) {
    showError(error);
  }
}

function handleInput(event) {
  if (event.target.id === 'chat-input') {
    state.chatDraft = event.target.value;
  }
}

function handleKeydown(event) {
  if (event.key === 'Escape' && state.modalOpen) {
    closeModal();
    return;
  }
  if (event.target?.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey) {
    if (event.isComposing || event.keyCode === 229 || state.chatComposing) return;
    event.preventDefault();
    if (state.match?.controls?.canAskDafeiyu && !state.askBusy) {
      event.target.closest('form')?.requestSubmit();
    } else {
      toast(dafeiyuAskHint(state.match) || '现在先不要提问。', 'info');
    }
    return;
  }
  if (event.target?.id === 'chat-input') {
    state.chatDraft = event.target.value;
  }
  if (state.route?.name === 'replay' && !state.modalOpen) {
    const tag = event.target?.tagName?.toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tag) || event.target?.isContentEditable) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setReplayStep(state.replayStep - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setReplayStep(state.replayStep + 1);
    }
  }
}

async function init() {
  try {
    const boot = await api('/api/bootstrap');
    state.boot = boot;
    state.models = boot.models ?? [];
    state.dafeiyu = boot.dafeiyu ?? null;
    state.historyFilters = { player: '', result: '', status: '', game: '', q: '' };
    state.lobby.gameId = boot.games?.[0]?.id ?? 'gomoku';
    ensureLobbyGame(state.lobby.gameId);
    if (boot.dafeiyu) {
      state.lobby.autoComment = boot.dafeiyu.autoCommentByDefault !== false;
      state.lobby.voice = Boolean(boot.dafeiyu.voiceByDefault);
    }
    if (!window.location.hash) {
      history.replaceState(null, '', '#/lobby');
    }
    window.addEventListener('hashchange', () => void handleRoute());
    document.addEventListener('click', (event) => { void handleClick(event); });
    document.addEventListener('change', (event) => { void handleChange(event); });
    document.addEventListener('submit', (event) => { void handleSubmit(event); });
    document.addEventListener('input', handleInput);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('compositionstart', (event) => {
      if (event.target?.id === 'chat-input') state.chatComposing = true;
    }, true);
    document.addEventListener('compositionend', (event) => {
      if (event.target?.id !== 'chat-input') return;
      state.chatComposing = false;
      state.chatDraft = event.target.value;
      syncChatForm(state.match);
      if (state.pendingMatchUpdate) {
        state.pendingMatchUpdate = false;
        updateMatchView();
      }
    }, true);
    document.querySelector('.skip-link')?.addEventListener('click', (event) => {
      event.preventDefault();
      document.querySelector('#main-content')?.focus();
    });
    window.addEventListener('beforeunload', () => {
      if (state.route?.name === 'match' && state.match?.id) {
        releaseMatchSession(state.match.id, '关闭或刷新页面');
      }
      closeMatchStream();
    });
    await handleRoute();
  } catch (error) {
    renderFatalError(error);
  }
}

void init();
