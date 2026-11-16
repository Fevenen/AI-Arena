import {
  ArenaError,
  RuleError,
  createId,
  createSeed,
  buildReplay,
  filterVisible,
} from '../../packages/core/index.mjs';
import {
  ModelError,
  requestModelCompletion,
  BuiltInBot,
} from '../../packages/models/index.mjs';
import { getGame, listGames } from '../../packages/games/index.mjs';
import { DafeiyuClient, DafeiyuError } from './dafeiyu-client.mjs';

const KIND_LABELS = {
  human: '真人',
  bot: '内置机器人',
  model: '模型',
  dafeiyu: '大肥鱼',
};

const AUTO_PRIORITY = new Set(['game_end', 'game_draw']);

function nowIso() {
  return new Date().toISOString();
}

function compactText(value, max = 500) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function resultForOutcome(match, outcome) {
  if (!outcome) return { result: null, resultLabel: null };
  if (outcome.type === 'win') {
    const seat = match.seats[outcome.winnerSeat];
    return {
      result: outcome.winnerSeat === 'black' ? 'black_win' : 'white_win',
      resultLabel: `${outcome.winnerSeat === 'black' ? '黑方' : '白方'} · ${seat?.name ?? ''} 获胜`,
    };
  }
  if (outcome.type === 'draw') return { result: 'draw', resultLabel: '和棋' };
  if (outcome.type === 'aborted') return { result: 'aborted', resultLabel: '对局已结束' };
  return { result: outcome.type, resultLabel: outcome.type };
}

function publicModelSnapshot(model) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    timeoutMs: model.timeoutMs,
    maxRetries: model.maxRetries,
  };
}

export class MatchService {
  constructor({
    configStore,
    store,
    hub,
    logger = console,
    clientFactory = (settings) => new DafeiyuClient(settings),
    originProvider = null,
    version = '0.1.0',
  }) {
    this.configStore = configStore;
    this.store = store;
    this.hub = hub;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.originProvider = originProvider
      ?? (() => `http://127.0.0.1:${this.configStore.server.port}`);
    this.version = version;
    this.matches = new Map();
    this.runtimes = new Map();
    this.closed = false;
    this.loadExisting();
  }

  loadExisting() {
    const all = this.store.loadAll();
    for (const match of all) {
      if (!match.chat) match.chat = [];
      if (!match.errors) match.errors = [];
      if (!match.events) match.events = [];
      if (!match.privateBySeat || typeof match.privateBySeat !== 'object') match.privateBySeat = {};
      if (!Array.isArray(match.randomEvents)) match.randomEvents = [];
      if (!Number.isInteger(match.revision)) match.revision = 0;
      if (!['playing', 'paused', 'finished', 'aborted'].includes(match.status)) {
        match.status = 'aborted';
      }
      if (match.status === 'playing' || match.status === 'paused') {
        // 重启时不恢复上一进程的模型/Dafeiyu 会话，也不让旧回合复活。
        match.status = 'aborted';
        match.finishedAt = nowIso();
        match.outcome = {
          type: 'aborted',
          reason: '服务重启，未完成的对局已自动结束。',
        };
        match.result = 'aborted';
        match.resultLabel = '服务重启 · 未完成';
        match.pause = null;
        match.pending = null;
        match.updatedAt = nowIso();
        match.events.push({
          seq: match.events.length + 1,
          at: match.updatedAt,
          step: match.actions?.length ?? 0,
          type: 'recovered_as_aborted',
          visibility: 'public',
          data: { reason: '服务重启' },
        });
        this.store.save(match);
      }
      this.matches.set(match.id, match);
      this.runtimes.set(match.id, this.emptyRuntime(match));
    }
  }

  emptyRuntime(match) {
    const seen = new Set(
      (match.chat ?? []).filter((item) => item.eventKey).map((item) => item.eventKey),
    );
    return {
      epoch: 0,
      pending: null,
      stepOnce: false,
      scheduleTimer: null,
      modelConfigs: {},
      dafeiyu: null,
      dafeiyuBusy: false,
      autoPendingKey: null,
      seenAutoKeys: seen,
      lastAutoCommentAt: match.dafeiyu?.lastCommentAt
        ? Date.parse(match.dafeiyu.lastCommentAt)
        : 0,
      archived: true,
    };
  }

  get games() {
    return listGames();
  }

  _runtime(matchId) {
    return this.runtimes.get(matchId) ?? null;
  }

  _getMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) throw new ArenaError('match_not_found', '找不到这局对局。', { status: 404 });
    return match;
  }

  _visibleActions(match, viewer) {
    return filterVisible(
      match.actions.map((action) => ({ ...action, visibility: action.visibility ?? 'public' })),
      viewer,
    );
  }

  publicMatch(match, viewer = { role: 'observer', seat: null }) {
    if (!match) return null;
    const runtime = this._runtime(match.id);
    const controls = this._controls(match, runtime);
    return {
      id: match.id,
      schemaVersion: match.schemaVersion,
      revision: Number(match.revision ?? 0),
      gameId: match.gameId,
      gameName: match.gameName,
      rulesVersion: match.rulesVersion,
      modeLabel: match.modeLabel,
      createdAt: match.createdAt,
      startedAt: match.startedAt,
      finishedAt: match.finishedAt,
      updatedAt: match.updatedAt,
      status: match.status,
      result: match.result,
      resultLabel: match.resultLabel,
      outcome: match.outcome,
      seats: match.seats,
      state: match.state,
      actions: this._visibleActions(match, viewer),
      actionCount: match.actions.length,
      lastAction: this._visibleActions(match, viewer).at(-1) ?? null,
      chat: filterVisible(match.chat, viewer),
      errors: match.errors.slice(-50),
      events: filterVisible(match.events, viewer).slice(-100),
      pause: match.pause,
      pending: match.pending,
      dafeiyu: {
        ...match.dafeiyu,
        busy: Boolean(runtime?.dafeiyuBusy || runtime?.autoPendingKey),
        viewers: this.hub.count(match.id),
      },
      controls,
      viewers: this.hub.count(match.id),
      configSnapshot: match.configSnapshot,
      recovered: Boolean(match.recovered),
      archived: Boolean(runtime?.archived),
    };
  }

  _hasDafeiyuSeat(match) {
    return Object.values(match.seats).some((seat) => seat.kind === 'dafeiyu');
  }

  _allAi(match) {
    return !Object.values(match.seats).some((seat) => seat.kind === 'human');
  }

  _controls(match, runtime) {
    const active = match.status === 'playing' || match.status === 'paused';
    const paused = match.status === 'paused';
    const humanSeat = Object.values(match.seats).find((seat) => seat.kind === 'human');
    const pausedCode = match.pause?.code ?? '';
    const canReconnect = match.dafeiyu?.enabled
      && match.dafeiyu.status !== 'connected'
      && Boolean(runtime)
      && !runtime.archived;
    return {
      canPause: match.status === 'playing',
      canResume: paused && match.pause?.resumeable !== false && Boolean(runtime) && !runtime.archived,
      canStep: paused
        && this._allAi(match)
        && !runtime?.pending
        && Boolean(runtime)
        && !runtime.archived,
      canRetry: paused
        && ['model_error', 'ai_invalid_move', 'dafeiyu_error', 'dafeiyu_disconnected', 'step_failed'].includes(pausedCode)
        && Boolean(runtime)
        && !runtime.archived,
      canEnd: active,
      canAskDafeiyu: Boolean(match.dafeiyu?.enabled)
        && match.dafeiyu.status === 'connected'
        && !runtime?.dafeiyuBusy
        && Boolean(runtime)
        && !runtime.archived,
      canReconnect,
      canToggleDafeiyu: !this._hasDafeiyuSeat(match) && Boolean(runtime) && !runtime.archived,
      humanSeat: humanSeat?.id ?? null,
      isHumanTurn: humanSeat?.id === match.state.turn && match.status === 'playing',
      allAi: this._allAi(match),
    };
  }

  _persist(match, { broadcast = true } = {}) {
    match.revision = Number(match.revision ?? 0) + 1;
    match.updatedAt = nowIso();
    this.store.save(match);
    if (broadcast) {
      this.hub.publish(match.id, 'match', this.publicMatch(match));
    }
  }

  _event(match, type, data = {}) {
    match.events.push({
      seq: match.events.length + 1,
      at: nowIso(),
      step: match.actions.length,
      type,
      visibility: 'public',
      data,
    });
    if (match.events.length > 1000) match.events.splice(0, match.events.length - 1000);
  }

  _recordError(match, { code, message, seat = null, source = 'server' }) {
    match.errors.push({
      id: createId('err'),
      at: nowIso(),
      step: match.actions.length,
      seat,
      source,
      code,
      message: compactText(message, 500),
    });
    if (match.errors.length > 200) match.errors.splice(0, match.errors.length - 200);
    this._event(match, 'error', { code, message, seat, source });
  }

  _addChat(match, { role, text, kind, seat = null, authorName = null, eventKey = null, voiceStatus = 'off' }) {
    const cleaned = compactText(text, 600);
    if (!cleaned) return null;
    const chat = {
      id: createId('chat'),
      at: nowIso(),
      step: match.actions.length,
      role,
      seat,
      ...(authorName ? { authorName } : {}),
      kind,
      text: cleaned,
      visibility: 'public',
      ...(eventKey ? { eventKey } : {}),
      voiceStatus,
    };
    match.chat.push(chat);
    this._event(match, 'chat', { role, seat, kind, text: cleaned.slice(0, 160) });
    return chat;
  }

  _createSeat(seatId, input, runtime) {
    const kind = input?.kind;
    if (!KIND_LABELS[kind]) {
      throw new ArenaError('invalid_seat', `${seatId} 的座位类型无效。`);
    }
    const base = {
      id: seatId,
      side: seatId,
      kind,
      colorName: seatId === 'black' ? '黑方' : '白方',
    };
    if (kind === 'human') {
      return {
        ...base,
        name: '你',
        engineLabel: '真人 · 本机',
      };
    }
    if (kind === 'bot') {
      return {
        ...base,
        name: '内置机器人',
        engineLabel: '内置机器人 · 无需 Key',
        provider: 'built-in',
      };
    }
    if (kind === 'dafeiyu') {
      return {
        ...base,
        name: '大肥鱼',
        engineLabel: '大肥鱼 · 桌宠服务',
        provider: 'dafeiyu',
      };
    }
    if (kind === 'model') {
      if (typeof input.modelId !== 'string' || !input.modelId) {
        throw new ArenaError('invalid_seat', `${seatId} 选择了模型，但没有指定模型配置。`);
      }
      const model = this.configStore.modelConfig(input.modelId);
      if (!model) {
        throw new ArenaError('model_not_found', `${seatId} 使用的模型配置已不存在。`, { status: 404 });
      }
      runtime.modelConfigs[seatId] = structuredClone(model);
      return {
        ...base,
        name: model.name,
        engineLabel: '普通模型 · ' + model.name,
        provider: model.provider,
        modelId: model.id,
        modelName: model.name,
        modelProvider: model.provider,
        modelApiModelId: model.modelId,
      };
    }
    throw new ArenaError('invalid_seat', `${seatId} 的座位类型无效。`);
  }

  _modeLabel(seats) {
    const kinds = [seats.black.kind, seats.white.kind];
    if (!kinds.includes('human')) {
      return `${seats.black.name} 对 ${seats.white.name} · 全 AI 观战`;
    }
    if (seats.black.kind === 'human' || seats.white.kind === 'human') {
      const ai = seats.black.kind === 'human' ? seats.white : seats.black;
      return `真人对${KIND_LABELS[ai.kind]} · ${ai.name}`;
    }
    return `${seats.black.name} 对 ${seats.white.name}`;
  }

  async createMatch(payload = {}) {
    if (this.closed) throw new ArenaError('server_closed', '服务正在关闭。', { status: 503 });
    const game = getGame(payload.gameId);
    if (!game) {
      throw new ArenaError('game_not_found', '未找到这个桌游插件。', { status: 404 });
    }
    const rawSeats = payload.seats ?? { black: payload.black, white: payload.white };
    if (!rawSeats?.black || !rawSeats?.white) {
      throw new ArenaError('invalid_seats', '必须同时配置黑方和白方座位。');
    }
    const runtime = {
      epoch: 0,
      pending: null,
      stepOnce: false,
      scheduleTimer: null,
      modelConfigs: {},
      dafeiyu: null,
      dafeiyuBusy: false,
      autoPendingKey: null,
      seenAutoKeys: new Set(),
      lastAutoCommentAt: 0,
      archived: false,
    };
    const seats = {
      black: this._createSeat('black', rawSeats.black, runtime),
      white: this._createSeat('white', rawSeats.white, runtime),
    };
    if (Object.values(seats).filter((seat) => seat.kind === 'human').length > 1) {
      throw new ArenaError('invalid_seats', '第一版只支持一局一个真人，双方不能都选真人。', {
        details: ['可以使用真人 + AI，或双方都由 AI 控制。'],
      });
    }
    if (Object.values(seats).filter((seat) => seat.kind === 'dafeiyu').length > 1) {
      throw new ArenaError('invalid_seats', '一局只能有一个大肥鱼棋手。');
    }

    const anyDafeiyuSeat = Object.values(seats).some((seat) => seat.kind === 'dafeiyu');
    const requestedDafeiyu = payload.dafeiyu ?? {};
    const dafeiyuEnabled = anyDafeiyuSeat || requestedDafeiyu.enabled === true;
    const defaults = this.configStore.dafeiyuSettings();
    const autoComment = dafeiyuEnabled
      ? Boolean(requestedDafeiyu.autoComment ?? defaults.autoCommentByDefault ?? true)
      : false;
    const voice = dafeiyuEnabled ? Boolean(requestedDafeiyu.voice ?? defaults.voiceByDefault ?? false) : false;
    const now = nowIso();
    const seed = createSeed();
    const initialState = game.createInitialState({ seed });
    const match = {
      schemaVersion: 1,
      id: createId('match'),
      gameId: game.id,
      gameName: game.name,
      rulesVersion: game.rulesVersion,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
      revision: 0,
      status: 'playing',
      seed,
      randomEvents: [],
      privateBySeat: {},
      modeLabel: this._modeLabel(seats),
      seats,
      state: initialState,
      actions: [],
      chat: [],
      errors: [],
      events: [],
      pause: null,
      pending: null,
      outcome: null,
      result: null,
      resultLabel: null,
      dafeiyu: {
        enabled: dafeiyuEnabled,
        status: dafeiyuEnabled ? 'connecting' : 'off',
        personaName: '大肥鱼',
        autoComment,
        voice,
        lastError: null,
        lastCommentAt: null,
      },
      configSnapshot: {
        game: { id: game.id, name: game.name, rulesVersion: game.rulesVersion },
        seats: Object.fromEntries(
          Object.entries(seats).map(([id, seat]) => [id, {
            kind: seat.kind,
            name: seat.name,
            modelId: seat.modelId ?? null,
            modelName: seat.modelName ?? null,
            engineLabel: seat.engineLabel,
          }]),
        ),
        models: Object.entries(runtime.modelConfigs).map(([seatId, model]) => ({
          seatId,
          ...publicModelSnapshot(model),
        })),
        dafeiyu: { enabled: dafeiyuEnabled, autoComment, voice },
      },
    };
    this._event(match, 'match_created', {
      gameId: game.id,
      rulesVersion: game.rulesVersion,
      seats: Object.fromEntries(Object.entries(seats).map(([id, seat]) => [id, { kind: seat.kind, name: seat.name }])),
      dafeiyuEnabled,
    });
    this.matches.set(match.id, match);
    this.runtimes.set(match.id, runtime);
    this._persist(match);
    this.logger.info?.(`创建对局 ${match.id} (${match.gameId})`);

    // 连接桌宠可能受本机服务启动时间影响，不阻塞创建响应。
    void this._afterCreate(match);
    return this.publicMatch(match);
  }

  async _afterCreate(match) {
    if (!this.matches.has(match.id)) return;
    const dafeiyuSeat = this._hasDafeiyuSeat(match);
    if (match.dafeiyu.enabled && dafeiyuSeat) {
      // 大肥鱼入座时必须先确认连接，否则不能替她自动落子。
      await this._connectDafeiyu(match, { initial: true });
    } else if (match.dafeiyu.enabled) {
      // 只观战时，桌宠连接不应阻塞棋局开始。
      void this._connectDafeiyu(match, { initial: true });
    }
    if (!this.matches.has(match.id) || match.status !== 'playing') return;
    const current = match.state.turn;
    if (current && match.seats[current].kind !== 'human') {
      this._scheduleAi(match, {
        delayMs: this.configStore.matchSettings.initialAiDelayMs,
      });
    }
  }

  _originForDafeiyu(settings) {
    return settings.origin || this.originProvider();
  }

  _makeDafeiyuClient(settings) {
    return this.clientFactory({
      bridgeUrl: settings.bridgeUrl,
      apiBase: settings.apiBase,
      token: settings.token,
      origin: this._originForDafeiyu(settings),
      timeoutMs: settings.timeoutMs,
    });
  }

  async _connectDafeiyu(match, { initial = false } = {}) {
    const runtime = this._runtime(match.id);
    if (!runtime || runtime.archived) return false;
    if (!match.dafeiyu.enabled) {
      match.dafeiyu.status = 'off';
      return false;
    }
    if (runtime.dafeiyu) {
      void runtime.dafeiyu.client.leave({
        sessionId: runtime.dafeiyu.sessionId,
        matchId: match.id,
      }).catch(() => {});
      this._clearHealth(match.id);
      runtime.dafeiyu = null;
    }
    match.dafeiyu.status = 'connecting';
    match.dafeiyu.lastError = null;
    this._persist(match);
    const settings = this.configStore.dafeiyuSettings();
    const client = this._makeDafeiyuClient(settings);
    try {
      const result = await client.connect({ matchId: match.id, client: `AI Arena ${this.version}` });
      if (!this.matches.has(match.id) || !match.dafeiyu.enabled) {
        void client.leave({ sessionId: result.sessionId, matchId: match.id }).catch(() => {});
        return false;
      }
      runtime.dafeiyu = {
        client,
        sessionId: result.sessionId,
        personaName: result.personaName || '大肥鱼',
        checking: false,
      };
      match.dafeiyu.status = 'connected';
      match.dafeiyu.personaName = result.personaName || '大肥鱼';
      match.dafeiyu.lastError = null;
      match.dafeiyu.connectedAt = nowIso();
      this._event(match, 'dafeiyu_connected', { personaName: match.dafeiyu.personaName });
      this._persist(match);
      this._startHealth(match);
      return true;
    } catch (error) {
      const publicError = error instanceof DafeiyuError
        ? error.toPublic()
        : { code: 'dafeiyu_error', message: '连接大肥鱼失败。' };
      match.dafeiyu.status = 'disconnected';
      match.dafeiyu.lastError = publicError;
      this._recordError(match, {
        code: publicError.code,
        message: publicError.message,
        source: 'dafeiyu',
      });
      if (this._hasDafeiyuSeat(match) && match.status === 'playing') {
        this._pauseMatch(match, {
          code: 'dafeiyu_disconnected',
          reason: '大肥鱼棋手未连接：' + publicError.message,
          resumeable: true,
        });
      }
      this._persist(match);
      if (initial) this.logger.warn?.(`大肥鱼连接失败（${match.id}）：${publicError.message}`);
      return false;
    }
  }

  _startHealth(match) {
    this._clearHealth(match.id);
    const runtime = this._runtime(match.id);
    if (!runtime?.dafeiyu) return;
    const interval = Math.max(
      5000,
      Number(this.configStore.dafeiyuSettings().healthIntervalMs) || 15000,
    );
    runtime.dafeiyu.healthTimer = setInterval(() => {
      void this._checkDafeiyuHealth(match.id);
    }, interval);
    runtime.dafeiyu.healthTimer.unref?.();
  }

  _clearHealth(matchId) {
    const runtime = this._runtime(matchId);
    if (runtime?.dafeiyu?.healthTimer) clearInterval(runtime.dafeiyu.healthTimer);
    if (runtime?.dafeiyu) runtime.dafeiyu.healthTimer = null;
  }

  async _checkDafeiyuHealth(matchId) {
    const match = this.matches.get(matchId);
    const runtime = this._runtime(matchId);
    if (!match || !runtime?.dafeiyu || runtime.dafeiyu.checking) return;
    if (!match.dafeiyu.enabled || match.status === 'aborted') {
      this._clearHealth(matchId);
      return;
    }
    runtime.dafeiyu.checking = true;
    try {
      await runtime.dafeiyu.client.status({
        sessionId: runtime.dafeiyu.sessionId,
        matchId: match.id,
      });
    } catch (error) {
      if (!this.matches.has(matchId)) return;
      const wasConnected = match.dafeiyu.status === 'connected';
      if (wasConnected) {
        this._markDafeiyuDisconnected(match, error, '大肥鱼连接已断开');
      }
    } finally {
      if (runtime.dafeiyu) runtime.dafeiyu.checking = false;
    }
  }

  _markDafeiyuDisconnected(match, error, prefix = '大肥鱼连接异常') {
    const runtime = this._runtime(match.id);
    const publicError = error instanceof DafeiyuError
      ? error.toPublic()
      : { code: 'dafeiyu_error', message: '大肥鱼连接异常。' };
    this._clearHealth(match.id);
    if (runtime) runtime.dafeiyu = null;
    if (match.dafeiyu.status === 'connected' || match.dafeiyu.status === 'connecting') {
      match.dafeiyu.status = 'disconnected';
      match.dafeiyu.lastError = publicError;
      this._recordError(match, {
        code: publicError.code,
        message: `${prefix}：${publicError.message}`,
        source: 'dafeiyu',
      });
      this._event(match, 'dafeiyu_disconnected', { code: publicError.code });
      if (this._hasDafeiyuSeat(match) && match.status === 'playing') {
        this._pauseMatch(match, {
          code: 'dafeiyu_disconnected',
          reason: '大肥鱼棋手掉线：' + publicError.message,
          resumeable: true,
        });
      }
      this._persist(match);
    }
  }

  _scheduleAi(match, { delayMs = null } = {}) {
    if (this.closed) return;
    const runtime = this._runtime(match.id);
    if (!runtime || runtime.archived || runtime.pending || runtime.scheduleTimer) return;
    if (match.status !== 'playing') return;
    const seatId = match.state.turn;
    if (!seatId || match.seats[seatId].kind === 'human') return;
    const delay = delayMs ?? this.configStore.matchSettings.aiMoveDelayMs;
    runtime.scheduleTimer = setTimeout(() => {
      runtime.scheduleTimer = null;
      void this._beginAiTurn(match.id, { singleStep: false });
    }, Math.max(0, Number(delay) || 0));
  }

  _clearSchedule(matchId) {
    const runtime = this._runtime(matchId);
    if (runtime?.scheduleTimer) {
      clearTimeout(runtime.scheduleTimer);
      runtime.scheduleTimer = null;
    }
  }

  _pendingPublic(seat, sourceLabel, attempt, kind) {
    return {
      seat,
      sourceLabel,
      attempt,
      kind,
      startedAt: nowIso(),
    };
  }

  _isActiveRequest(match, runtime, context) {
    if (!runtime || runtime.archived) return false;
    if (this.closed || !this.matches.has(match.id)) return false;
    if (runtime.epoch !== context.epoch) return false;
    if (match.actions.length !== context.actionIndex) return false;
    if (match.state.turn !== context.seat) return false;
    if (runtime.pending?.requestId !== context.requestId) return false;
    if (match.status === 'playing') return true;
    return match.status === 'paused' && runtime.stepOnce;
  }

  async _beginAiTurn(matchId, { singleStep }) {
    const match = this.matches.get(matchId);
    const runtime = this._runtime(matchId);
    if (!match || !runtime || runtime.pending) return;
    if (singleStep) {
      if (!runtime.stepOnce) return;
    } else if (match.status !== 'playing') {
      return;
    }
    const seat = match.state.turn;
    if (!seat) return;
    const seatConfig = match.seats[seat];
    if (seatConfig.kind === 'human') return;
    if (seatConfig.kind === 'dafeiyu' && match.dafeiyu.status !== 'connected') {
      this._pauseMatch(match, {
        code: 'dafeiyu_disconnected',
        reason: '大肥鱼棋手未连接，请先重连后再继续。',
        resumeable: true,
      });
      this._persist(match);
      return;
    }
    const requestId = createId('move');
    const context = {
      requestId,
      seat,
      actionIndex: match.actions.length,
      epoch: runtime.epoch,
      singleStep: Boolean(singleStep),
      controller: new AbortController(),
      feedback: '',
    };
    const maxAttempts = seatConfig.kind === 'bot'
      ? 1
      : Math.max(
        1,
        1 + (
          runtime.modelConfigs[seat]?.maxRetries
          ?? this.configStore.matchSettings.maxModelRetries
          ?? 2
        ),
      );
    const sourceLabel = seatConfig.kind === 'model'
      ? `${seatConfig.modelName} 思考中`
      : seatConfig.kind === 'dafeiyu'
        ? '大肥鱼思考中'
        : '内置机器人思考中';
    runtime.pending = { ...context, maxAttempts, attempt: 1 };
    match.pending = this._pendingPublic(seat, sourceLabel, 1, seatConfig.kind);
    this._persist(match);
    await this._runAiTurn(match, context, maxAttempts);
  }

  async _requestAiAction(match, context) {
    const runtime = this._runtime(match.id);
    const seatConfig = match.seats[context.seat];
    const game = getGame(match.gameId);
    if (!game) throw new Error('游戏插件不存在');
    if (seatConfig.kind === 'bot') {
      const bot = new BuiltInBot({ game, seat: context.seat, seed: match.seed });
      const action = await bot.chooseAction(match.state);
      return { action, say: '', source: 'bot', sourceName: seatConfig.name };
    }
    if (seatConfig.kind === 'model') {
      const config = runtime.modelConfigs[context.seat];
      if (!config) {
        throw new ModelError('unavailable', '这一席位的模型配置已不可用，请重新配置。', {
          stage: 'config',
          retryable: false,
        });
      }
      const description = game.describeForModel({
        state: match.state,
        seatId: context.seat,
        recentActions: match.actions.slice(-8),
      });
      const messages = [
        {
          role: 'system',
          content: [
            `你是「${config.name}」，正在本机 AI 桌游竞技场中作为${description.seatLabel}下棋。`,
            '严格依据规则和当前棋盘思考；只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要解释过程。',
            '格式：{"move":"H8","say":"可选的一句公开想法"}。坐标必须使用给定棋盘坐标。',
            description.rulesText,
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `当前棋盘（B=黑，W=白，.=空）：\n${description.boardText}`,
            `坐标：列 ${game.coordinateSystem.columns}；行 ${game.coordinateSystem.rows}。例如 H8 是中央天元。`,
            `你执 ${description.seatLabel}，本回合由你落子。`,
            `最近落子：${JSON.stringify(description.lastMove)}`,
            context.feedback ? `上一次提交无效：${context.feedback}\n请重新选择一个空点。` : '',
            '现在只返回一个合法 JSON 落子对象。',
          ].filter(Boolean).join('\n\n'),
        },
      ];
      const completion = await requestModelCompletion(config, {
        messages,
        temperature: 0.2,
        maxTokens: 300,
        signal: context.controller.signal,
      });
      const parsed = game.parseModelMove(completion.text);
      if (!parsed.ok) {
        const error = new ModelError('ai_invalid_move', parsed.error, {
          stage: 'model',
          retryable: true,
        });
        throw error;
      }
      return {
        action: parsed.action,
        say: parsed.say,
        source: 'model',
        sourceName: config.name,
        modelMeta: {
          modelConfigId: config.id,
          modelId: config.modelId,
          provider: config.provider,
        },
      };
    }
    if (seatConfig.kind === 'dafeiyu') {
      if (match.dafeiyu.status !== 'connected' || !runtime.dafeiyu) {
        throw new DafeiyuError('dafeiyu_disconnected', '大肥鱼棋手已经掉线，对局已暂停。', {
          retryable: false,
        });
      }
      const snapshot = this._integrationSnapshot(match, {
        role: 'player',
        seat: context.seat,
        turn: context.seat,
      });
      const response = await runtime.dafeiyu.client.move({
        sessionId: runtime.dafeiyu.sessionId,
        matchId: match.id,
        seat: context.seat,
        snapshot,
        feedback: context.feedback,
        requestId: context.requestId,
        signal: context.controller.signal,
      });
      const raw = typeof response.raw === 'string'
        ? response.raw
        : response.move
          ? JSON.stringify({ move: response.move, say: response.say ?? '' })
          : '';
      const parsed = game.parseModelMove(raw);
      if (!parsed.ok) {
        throw new DafeiyuError('ai_invalid_move', parsed.error, { retryable: true });
      }
      const say = compactText(response.say ?? parsed.say ?? '', 120);
      return {
        action: parsed.action,
        say,
        source: 'dafeiyu',
        sourceName: match.dafeiyu.personaName || '大肥鱼',
      };
    }
    throw new ArenaError('invalid_seat', '该座位不支持自动落子。');
  }

  _aiErrorCode(error, seatKind) {
    if (error?.code === 'dafeiyu_disconnected') return 'dafeiyu_disconnected';
    if (seatKind === 'dafeiyu') return 'dafeiyu_error';
    if (error?.code === 'ai_invalid_move') return 'ai_invalid_move';
    return 'model_error';
  }

  async _runAiTurn(match, context, maxAttempts) {
    const runtime = this._runtime(match.id);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this._isActiveRequest(match, runtime, context)) return;
      runtime.pending.attempt = attempt;
      const seatLabel = match.seats[context.seat].name;
      const kind = match.seats[context.seat].kind;
      match.pending = {
        ...this._pendingPublic(
          context.seat,
          kind === 'model'
            ? `${seatLabel} 思考中`
            : kind === 'dafeiyu'
              ? '大肥鱼思考中'
              : '内置机器人思考中',
          attempt,
          kind,
        ),
        maxAttempts,
      };
      this._persist(match);
      let result;
      try {
        result = await this._requestAiAction(match, context);
      } catch (error) {
        if (!this._isActiveRequest(match, runtime, context)) return;
        const seatKind = match.seats[context.seat].kind;
        const retryable = error?.retryable !== false
          && error?.code !== 'cancelled'
          && error?.code !== 'dafeiyu_disconnected'
          && error?.code !== 'unavailable';
        if (retryable && attempt < maxAttempts) {
          context.feedback = error?.message ?? '上一次落子无效。';
          await sleep(120);
          continue;
        }
        if (seatKind === 'dafeiyu' && (error?.code === 'unreachable' || error?.code === 'timeout' || error?.code === 'auth' || error?.code === 'forbidden' || error?.code === 'unsupported')) {
          this._markDafeiyuDisconnected(match, error, '大肥鱼棋手请求失败');
        }
        const code = this._aiErrorCode(error, seatKind);
        const message = error?.message
          || (kind === 'model' ? '模型没有返回可用的落子。' : 'AI 没有返回可用的落子。');
        this._recordError(match, {
          code,
          message,
          seat: context.seat,
          source: kind,
        });
        this._failAiTurn(match, context, {
          code,
          reason: `${seatLabel}未能完成落子：${message}`,
          attempts: attempt,
        });
        return;
      }
      if (!this._isActiveRequest(match, runtime, context)) return;
      const game = getGame(match.gameId);
      const validation = game.validateAction(match.state, context.seat, result.action);
      if (!validation.ok) {
        if (attempt < maxAttempts) {
          context.feedback = validation.message;
          await sleep(120);
          continue;
        }
        this._recordError(match, {
          code: 'ai_invalid_move',
          message: validation.message,
          seat: context.seat,
          source: match.seats[context.seat].kind,
        });
        this._failAiTurn(match, context, {
          code: 'ai_invalid_move',
          reason: `${seatLabel}连续返回了非法落子：${validation.message}`,
          attempts: attempt,
        });
        return;
      }
      await this._commitAiAction(match, context, {
        ...result,
        action: validation.action,
      });
      return;
    }
  }

  _clearPending(match, runtime) {
    if (runtime?.pending?.controller) {
      runtime.pending.controller.abort();
    }
    if (runtime) runtime.pending = null;
    match.pending = null;
  }

  async _commitAiAction(match, context, result) {
    const runtime = this._runtime(match.id);
    if (!this._isActiveRequest(match, runtime, context)) return;
    const wasStep = runtime.stepOnce;
    this._clearPending(match, runtime);
    runtime.stepOnce = false;
    const accepted = this._acceptAction(match, {
      seat: context.seat,
      action: result.action,
      source: result.source,
      sourceName: result.sourceName,
      modelMeta: result.modelMeta ?? null,
      requestId: context.requestId,
      say: result.say,
    });
    if (wasStep && match.status !== 'finished') {
      runtime.epoch += 1;
      match.status = 'paused';
      match.pause = {
        at: nowIso(),
        code: 'step_done',
        reason: '已完成单步推进，对局保持暂停。',
        resumeable: true,
      };
      this._event(match, 'step_done', {});
    }
    this._persist(match);
    if (wasStep && match.status === 'paused') {
      this._clearSchedule(match.id);
    } else if (match.status === 'playing') {
      const nextSeat = match.state.turn;
      if (nextSeat && match.seats[nextSeat].kind !== 'human') {
        this._scheduleAi(match);
      }
    }
    if (match.status === 'finished') {
      this._clearHealth(match.id);
    }
    if (accepted.candidates.length) {
      void this._maybeAutoComment(match, accepted.candidates);
    }
    if (result.say && result.source === 'dafeiyu' && match.dafeiyu.enabled && match.dafeiyu.voice) {
      const chat = match.chat.at(-1);
      if (chat && chat.role === 'dafeiyu' && chat.kind === 'thought') {
        void this._speakDafeiyu(match, chat.text, `thought:${match.id}:${chat.id}`, chat.id);
      }
    }
  }

  _acceptAction(match, {
    seat,
    action,
    source,
    sourceName,
    clientActionId = null,
    requestId = null,
    modelMeta = null,
    say = '',
  }) {
    const game = getGame(match.gameId);
    const previous = match.state;
    const applied = game.applyAction(previous, seat, action);
    const at = nowIso();
    const entry = {
      index: match.actions.length + 1,
      seat,
      action,
      at,
      source,
      sourceName,
      visibility: 'public',
      ...(clientActionId ? { clientActionId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(modelMeta ? { modelMeta } : {}),
      event: applied.event ?? null,
    };
    match.actions.push(entry);
    match.state = applied.state;
    match.lastActionAt = at;
    this._event(match, 'move', {
      seat,
      source,
      sourceName,
      move: action.move ?? null,
      index: entry.index,
      outcome: applied.state.outcome,
    });
    if (say) {
      this._addChat(match, {
        role: source === 'dafeiyu' ? 'dafeiyu' : 'ai',
        text: compactText(say, 160),
        kind: 'thought',
        seat,
        authorName: sourceName,
        voiceStatus: 'off',
      });
    }
    if (applied.state.outcome) {
      match.outcome = { ...applied.state.outcome };
      if (match.outcome.winnerSeat) {
        match.outcome.winnerName = match.seats[match.outcome.winnerSeat]?.name ?? '';
      }
      const result = resultForOutcome(match, match.outcome);
      match.result = result.result;
      match.resultLabel = result.resultLabel;
      match.status = 'finished';
      match.finishedAt = at;
      match.pause = null;
      this._event(match, 'match_finished', {
        result: match.result,
        outcome: match.outcome,
      });
    }
    const candidates = typeof game.autoCommentCandidates === 'function'
      ? game.autoCommentCandidates({
        previous,
        state: match.state,
        action: entry,
        chat: match.chat,
      })
      : [];
    return { candidates: Array.isArray(candidates) ? candidates : [] };
  }

  async submitHumanAction(matchId, { seat, action, clientActionId = null } = {}) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '这是一局已归档的对局，只能查看回放。', { status: 409 });
    }
    if (clientActionId != null && String(clientActionId).length > 160) {
      throw new ArenaError('invalid_idempotency_key', '提交标识过长。');
    }
    if (clientActionId) {
      const previous = match.actions.find((item) => item.clientActionId === String(clientActionId));
      if (previous) {
        return { match: this.publicMatch(match), accepted: true, duplicate: true };
      }
    }
    if (match.status !== 'playing') {
      throw new ArenaError('match_not_playing', match.status === 'paused' ? '对局已暂停，请先继续。' : '对局已经结束。', {
        status: 409,
      });
    }
    if (match.pending) {
      throw new ArenaError('turn_busy', '当前正在等待 AI 行动，请稍候。', { status: 409 });
    }
    if (!seat || !match.seats[seat]) {
      throw new ArenaError('invalid_seat', '没有这个座位。');
    }
    if (match.seats[seat].kind !== 'human') {
      throw new ArenaError('not_human_seat', '这个座位不是真人，不能从棋盘提交落子。', { status: 403 });
    }
    if (match.state.turn !== seat) {
      throw new ArenaError('wrong_turn', `现在轮到${match.state.turn === 'black' ? '黑方' : '白方'}。`, {
        status: 409,
      });
    }
    const game = getGame(match.gameId);
    const validation = game.validateAction(match.state, seat, action);
    if (!validation.ok) {
      this._recordError(match, {
        code: validation.code,
        message: validation.message,
        seat,
        source: 'human',
      });
      this._persist(match);
      throw new ArenaError(validation.code, validation.message, {
        status: validation.code === 'game_over' ? 409 : 400,
        details: validation.details ?? null,
      });
    }
    const wasStep = runtime.stepOnce;
    runtime.stepOnce = false;
    const accepted = this._acceptAction(match, {
      seat,
      action: validation.action,
      source: 'human',
      sourceName: match.seats[seat].name,
      clientActionId: clientActionId ? String(clientActionId) : null,
    });
    if (wasStep && match.status === 'playing') {
      match.status = 'paused';
      match.pause = {
        at: nowIso(),
        code: 'step_done',
        reason: '已完成单步推进，对局保持暂停。',
        resumeable: true,
      };
    }
    this._persist(match);
    if (match.status === 'playing' && match.state.turn && match.seats[match.state.turn].kind !== 'human') {
      this._scheduleAi(match);
    }
    if (match.status === 'finished') {
      this._clearHealth(match.id);
    }
    if (accepted.candidates.length) {
      void this._maybeAutoComment(match, accepted.candidates);
    }
    return { match: this.publicMatch(match), accepted: true, duplicate: false };
  }

  _failAiTurn(match, context, { code, reason, attempts = 1 }) {
    const runtime = this._runtime(match.id);
    if (!this._isActiveRequest(match, runtime, context)) return;
    this._clearPending(match, runtime);
    runtime.stepOnce = false;
    runtime.epoch += 1;
    match.status = 'paused';
    match.pause = {
      at: nowIso(),
      code,
      reason,
      attempts,
      resumeable: true,
    };
    this._event(match, 'match_paused', { code, reason, attempts });
    this._persist(match);
    this._clearSchedule(match.id);
  }

  _pauseMatch(match, { code, reason, resumeable = true }) {
    const runtime = this._runtime(match.id);
    this._clearSchedule(match.id);
    if (runtime) {
      runtime.epoch += 1;
      runtime.stepOnce = false;
      this._clearPending(match, runtime);
    }
    if (match.status !== 'finished' && match.status !== 'aborted') {
      match.status = 'paused';
      match.pause = {
        at: nowIso(),
        code,
        reason,
        resumeable,
      };
      this._event(match, 'match_paused', { code, reason });
    }
  }

  pauseMatch(matchId) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能操作。', { status: 409 });
    }
    if (match.status !== 'playing') {
      throw new ArenaError('match_not_playing', '当前对局不在进行中。', { status: 409 });
    }
    this._pauseMatch(match, {
      code: 'manual_pause',
      reason: '已手动暂停。',
      resumeable: true,
    });
    this._persist(match);
    return this.publicMatch(match);
  }

  resumeMatch(matchId) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能继续。', { status: 409 });
    }
    if (match.status !== 'paused') {
      throw new ArenaError('match_not_paused', '当前对局没有暂停。', { status: 409 });
    }
    if (match.pause?.resumeable === false) {
      throw new ArenaError('pause_not_resumeable', '这局对局不能继续，请开始新对局。', { status: 409 });
    }
    if (match.dafeiyu.enabled && this._hasDafeiyuSeat(match) && match.dafeiyu.status !== 'connected') {
      throw new ArenaError('dafeiyu_disconnected', '大肥鱼棋手尚未重新连接，请先重连大肥鱼。', {
        status: 409,
      });
    }
    runtime.epoch += 1;
    match.status = 'playing';
    match.pause = null;
    this._event(match, 'match_resumed', {});
    this._persist(match);
    const current = match.state.turn;
    if (current && match.seats[current].kind !== 'human') {
      this._scheduleAi(match, { delayMs: 0 });
    }
    return this.publicMatch(match);
  }

  async stepMatch(matchId) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能单步推进。', { status: 409 });
    }
    if (!this._allAi(match)) {
      throw new ArenaError('step_requires_ai', '单步推进只用于双方都由 AI 控制的对局。', { status: 409 });
    }
    if (match.status !== 'paused') {
      throw new ArenaError('match_not_paused', '请先暂停，再单步推进。', { status: 409 });
    }
    if (match.pause?.resumeable === false) {
      throw new ArenaError('pause_not_resumeable', '这局对局不能继续。', { status: 409 });
    }
    if (runtime.pending) {
      throw new ArenaError('turn_busy', 'AI 正在思考，请稍候。', { status: 409 });
    }
    const seat = match.state.turn;
    if (!seat) throw new ArenaError('game_finished', '对局已经结束。', { status: 409 });
    if (match.seats[seat].kind === 'dafeiyu' && match.dafeiyu.status !== 'connected') {
      throw new ArenaError('dafeiyu_disconnected', '大肥鱼棋手尚未连接。', { status: 409 });
    }
    runtime.stepOnce = true;
    match.pause = {
      at: nowIso(),
      code: 'stepping',
      reason: '正在单步推进一步…',
      resumeable: true,
    };
    this._persist(match);
    await this._beginAiTurn(matchId, { singleStep: true });
    return this.publicMatch(match);
  }

  retryMatch(matchId) {
    const match = this._getMatch(matchId);
    if (match.status !== 'paused') {
      throw new ArenaError('match_not_paused', '只有暂停的对局可以重试。', { status: 409 });
    }
    const retryableCodes = new Set([
      'model_error',
      'ai_invalid_move',
      'dafeiyu_error',
      'dafeiyu_disconnected',
      'step_failed',
    ]);
    if (!retryableCodes.has(match.pause?.code)) {
      return this.resumeMatch(matchId);
    }
    return this.resumeMatch(matchId);
  }

  endMatch(matchId, { reason = '用户手动结束' } = {}) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能结束。', { status: 409 });
    }
    if (match.status === 'finished' || match.status === 'aborted') {
      return this.publicMatch(match);
    }
    this._clearSchedule(matchId);
    if (runtime) {
      runtime.epoch += 1;
      runtime.stepOnce = false;
      this._clearPending(match, runtime);
    }
    const at = nowIso();
    match.status = 'aborted';
    match.finishedAt = at;
    match.outcome = { type: 'aborted', reason: compactText(reason, 200) };
    match.result = 'aborted';
    match.resultLabel = '用户结束对局';
    match.pause = null;
    this._event(match, 'match_ended', { reason: match.outcome.reason });
    this._clearHealth(matchId);
    this._persist(match);
    return this.publicMatch(match);
  }

  _integrationSnapshot(match, { role, seat = null, turn = null }) {
    const game = getGame(match.gameId);
    const viewer = { role, seat };
    const visibleActions = filterVisible(match.actions, viewer);
    const view = role === 'player' && seat
      ? game.getSeatView(match.state, seat)
      : game.getPublicState(match.state);
    const description = game.describeForModel({
      state: match.state,
      seatId: seat ?? turn ?? match.state.turn ?? 'black',
      recentActions: visibleActions.slice(-8),
    });
    return {
      protocolVersion: 1,
      matchId: match.id,
      role,
      seat,
      game: {
        id: match.gameId,
        name: match.gameName,
        rulesVersion: match.rulesVersion,
        rulesText: game.rulesText,
        coordinateSystem: game.coordinateSystem,
        actionFormat: description.responseFormat,
      },
      turn: match.state.turn,
      moveCount: match.state.moveCount,
      state: view,
      outcome: match.outcome,
      recentActions: visibleActions.slice(-8).map((entry) => ({
        index: entry.index,
        seat: entry.seat,
        source: entry.source,
        move: entry.action?.move ?? null,
        at: entry.at,
        visibility: entry.visibility ?? 'public',
      })),
      recentChat: filterVisible(match.chat, viewer).slice(-8).map((chat) => ({
        role: chat.role,
        seat: chat.seat,
        kind: chat.kind,
        text: chat.text,
      })),
    };
  }

  _seenAutoKeys(match, runtime) {
    const keys = new Set(runtime.seenAutoKeys);
    for (const chat of match.chat) {
      if (chat.eventKey) keys.add(chat.eventKey);
    }
    return keys;
  }

  async _maybeAutoComment(match, candidates) {
    if (!match.dafeiyu.enabled || !match.dafeiyu.autoComment) return;
    if (match.dafeiyu.status !== 'connected') return;
    if (this.hub.count(match.id) < 1) return;
    const runtime = this._runtime(match.id);
    if (!runtime?.dafeiyu || runtime.autoPendingKey) return;
    const seen = this._seenAutoKeys(match, runtime);
    const ordered = [...candidates]
      .filter((item) => item?.key && !seen.has(item.key))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    if (!ordered.length) return;
    const candidate = ordered[0];
    const now = Date.now();
    const cooldown = this.configStore.matchSettings.autoCommentCooldownMs;
    if (!AUTO_PRIORITY.has(candidate.type) && now - runtime.lastAutoCommentAt < cooldown) {
      return;
    }
    if (!AUTO_PRIORITY.has(candidate.type) && runtime.lastAutoCommentAt && now - runtime.lastAutoCommentAt < 2500) {
      return;
    }
    runtime.autoPendingKey = candidate.key;
    void this._runAutoComment(match, candidate);
  }

  async _runAutoComment(match, candidate) {
    const runtime = this._runtime(match.id);
    const session = runtime?.dafeiyu;
    if (!session) return;
    try {
      const snapshot = this._integrationSnapshot(match, { role: 'observer' });
      const response = await session.client.comment({
        sessionId: session.sessionId,
        matchId: match.id,
        role: 'observer',
        seat: null,
        snapshot,
        event: {
          key: candidate.key,
          type: candidate.type,
          summary: candidate.summary,
          details: candidate.details ?? null,
        },
        mode: 'auto',
      });
      if (this.hub.count(match.id) < 1) return;
      if (match.status === 'aborted') return;
      if (!match.dafeiyu.enabled || !match.dafeiyu.autoComment) return;
      if (match.dafeiyu.status !== 'connected') return;
      if (runtime?.dafeiyu?.sessionId !== session.sessionId) return;
      const text = compactText(response.text, 180);
      if (!text) return;
      const chat = this._addChat(match, {
        role: 'dafeiyu',
        text,
        kind: 'comment',
        authorName: match.dafeiyu.personaName || '大肥鱼',
        eventKey: candidate.key,
        voiceStatus: match.dafeiyu.voice ? 'queued' : 'off',
      });
      runtime.seenAutoKeys.add(candidate.key);
      runtime.lastAutoCommentAt = Date.now();
      match.dafeiyu.lastCommentAt = nowIso();
      this._persist(match);
      if (match.dafeiyu.voice && chat) {
        void this._speakDafeiyu(match, text, `comment:${match.id}:${candidate.key}`, chat.id);
      }
    } catch (error) {
      if (!this.matches.has(match.id)) return;
      const publicError = error instanceof DafeiyuError
        ? error.toPublic()
        : { code: 'dafeiyu_comment_error', message: '大肥鱼自动点评失败。' };
      if (['unreachable', 'timeout', 'auth', 'forbidden', 'unsupported'].includes(publicError.code)) {
        this._markDafeiyuDisconnected(match, error, '大肥鱼连接异常');
      } else {
        this._recordError(match, {
          code: publicError.code,
          message: publicError.message,
          source: 'dafeiyu',
        });
        this._persist(match);
      }
    } finally {
      if (runtime) runtime.autoPendingKey = null;
    }
  }

  async askDafeiyu(matchId, { text, voice = null } = {}) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能向大肥鱼提问。', { status: 409 });
    }
    if (!match.dafeiyu.enabled || match.dafeiyu.status !== 'connected' || !runtime.dafeiyu) {
      throw new ArenaError('dafeiyu_disconnected', '大肥鱼未连接，无法提问。', { status: 409 });
    }
    const question = compactText(text, 500);
    if (!question) throw new ArenaError('empty_question', '问题不能为空。');
    if (runtime.dafeiyuBusy) {
      throw new ArenaError('dafeiyu_busy', '大肥鱼正在回答上一个问题，请稍候。', { status: 429 });
    }
    if (voice !== null && typeof voice === 'boolean') {
      match.dafeiyu.voice = voice;
    }
    runtime.dafeiyuBusy = true;
    this._addChat(match, { role: 'user', text: question, kind: 'question' });
    this._persist(match);
    const session = runtime.dafeiyu;
    try {
      const snapshot = this._integrationSnapshot(match, { role: 'observer' });
      const response = await session.client.question({
        sessionId: session.sessionId,
        matchId: match.id,
        role: 'observer',
        seat: null,
        snapshot,
        question,
      });
      const answer = compactText(response.text, 600);
      if (!answer) {
        throw new DafeiyuError('empty_answer', '大肥鱼没有返回可显示的答复。');
      }
      const chat = this._addChat(match, {
        role: 'dafeiyu',
        text: answer,
        kind: 'answer',
        authorName: match.dafeiyu.personaName || '大肥鱼',
        voiceStatus: match.dafeiyu.voice ? 'queued' : 'off',
      });
      this._event(match, 'dafeiyu_answer', { length: answer.length });
      runtime.dafeiyuBusy = false;
      this._persist(match);
      if (match.dafeiyu.voice && chat) {
        void this._speakDafeiyu(match, answer, `answer:${match.id}:${chat.id}`, chat.id);
      }
      return this.publicMatch(match);
    } catch (error) {
      runtime.dafeiyuBusy = false;
      const publicError = error instanceof DafeiyuError
        ? error.toPublic()
        : { code: 'dafeiyu_question_error', message: '大肥鱼暂时没有回答。' };
      this._recordError(match, {
        code: publicError.code,
        message: publicError.message,
        source: 'dafeiyu',
      });
      if (['unreachable', 'timeout', 'auth', 'forbidden', 'unsupported'].includes(publicError.code)) {
        this._markDafeiyuDisconnected(match, error, '大肥鱼连接异常');
      }
      this._persist(match);
      throw new ArenaError('dafeiyu_error', publicError.message, {
        status: 502,
        details: publicError,
      });
    }
  }

  async _speakDafeiyu(match, text, key, chatId) {
    const runtime = this._runtime(match.id);
    if (!match.dafeiyu.voice || match.dafeiyu.status !== 'connected' || !runtime?.dafeiyu) return;
    if (this.hub.count(match.id) < 1) return;
    const session = runtime.dafeiyu;
    try {
      const result = await session.client.speak({
        sessionId: session.sessionId,
        matchId: match.id,
        text,
        key,
      });
      if (runtime.dafeiyu?.sessionId !== session.sessionId) return;
      const chat = match.chat.find((item) => item.id === chatId);
      if (chat) chat.voiceStatus = result.voiceStatus ?? 'unknown';
      this._persist(match);
    } catch (error) {
      if (!this.matches.has(match.id)) return;
      const publicError = error instanceof DafeiyuError
        ? error.toPublic()
        : { code: 'dafeiyu_voice_error', message: '语音播报失败。' };
      if (['unreachable', 'timeout', 'auth', 'forbidden', 'unsupported'].includes(publicError.code)) {
        this._markDafeiyuDisconnected(match, error, '大肥鱼语音链路异常');
      } else {
        this._recordError(match, {
          code: publicError.code,
          message: publicError.message,
          source: 'dafeiyu_voice',
        });
        this._persist(match);
      }
    }
  }

  async patchDafeiyu(matchId, patch = {}) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能修改大肥鱼设置。', { status: 409 });
    }
    if (patch.autoComment != null) match.dafeiyu.autoComment = Boolean(patch.autoComment);
    if (patch.voice != null) match.dafeiyu.voice = Boolean(patch.voice);
    if (patch.enabled != null) {
      const enabled = Boolean(patch.enabled);
      if (!enabled && this._hasDafeiyuSeat(match)) {
        throw new ArenaError(
          'dafeiyu_seat_required',
          '大肥鱼已绑定棋手座位，不能关闭桌宠接入；可以关闭自动点评或语音。',
          { status: 409 },
        );
      }
      if (enabled && !match.dafeiyu.enabled) {
        match.dafeiyu.enabled = true;
        match.dafeiyu.status = 'connecting';
        this._persist(match);
        void this._connectDafeiyu(match);
        return this.publicMatch(match);
      }
      if (!enabled && match.dafeiyu.enabled) {
        await this._disconnectDafeiyuSession(match, { markOff: true });
        match.dafeiyu.enabled = false;
        match.dafeiyu.autoComment = false;
        match.dafeiyu.status = 'off';
        this._event(match, 'dafeiyu_disabled', {});
      }
    }
    this._persist(match);
    return this.publicMatch(match);
  }

  async _disconnectDafeiyuSession(match, { markOff = false } = {}) {
    const runtime = this._runtime(match.id);
    this._clearHealth(match.id);
    const session = runtime?.dafeiyu;
    if (runtime) runtime.dafeiyu = null;
    if (session) {
      try {
        await session.client.leave({ sessionId: session.sessionId, matchId: match.id });
      } catch {
        // 本机服务可能已经停止；断线状态由竞技场自身记录。
      }
    }
    if (!markOff) {
      match.dafeiyu.status = match.dafeiyu.enabled ? 'disconnected' : 'off';
      this._event(match, 'dafeiyu_disconnected', {});
    }
  }

  async reconnectDafeiyu(matchId) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能重连大肥鱼。', { status: 409 });
    }
    if (match.dafeiyu.enabled && match.dafeiyu.status === 'connected') {
      return this.publicMatch(match);
    }
    match.dafeiyu.enabled = true;
    if (!match.dafeiyu.autoComment) {
      match.dafeiyu.autoComment = Boolean(this.configStore.dafeiyuSettings().autoCommentByDefault ?? true);
    }
    this._persist(match);
    const connected = await this._connectDafeiyu(match);
    if (!connected) {
      throw new ArenaError(
        'dafeiyu_connect_failed',
        match.dafeiyu.lastError?.message ?? '大肥鱼连接失败，请检查桌宠服务。',
        {
          status: 503,
          details: match.dafeiyu.lastError ?? null,
        },
      );
    }
    return this.publicMatch(match);
  }

  async disconnectDafeiyu(matchId) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime || runtime.archived) {
      throw new ArenaError('archived_match', '归档对局不能操作大肥鱼连接。', { status: 409 });
    }
    await this._disconnectDafeiyuSession(match);
    if (this._hasDafeiyuSeat(match) && match.status === 'playing') {
      this._pauseMatch(match, {
        code: 'dafeiyu_disconnected',
        reason: '大肥鱼棋手连接已手动断开，重连后可继续。',
        resumeable: true,
      });
    }
    this._persist(match);
    return this.publicMatch(match);
  }

  listMatches({ player = '', result = '', status = '', q = '' } = {}) {
    const playerText = String(player ?? '').trim().toLowerCase();
    const resultText = String(result ?? '').trim();
    const statusText = String(status ?? '').trim();
    const query = String(q ?? '').trim().toLowerCase();
    return this.store.list().filter((item) => {
      if (resultText && item.result !== resultText) return false;
      if (statusText && item.status !== statusText) return false;
      const seats = Object.values(item.seats ?? {});
      const players = seats.map((seat) => `${seat.name} ${seat.engineLabel} ${seat.modelName ?? ''}`).join(' ').toLowerCase();
      if (playerText && !players.includes(playerText)) return false;
      if (query) {
        const haystack = `${item.id} ${item.gameName} ${players} ${item.modeLabel}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  getMatch(matchId) {
    return this.publicMatch(this._getMatch(matchId));
  }

  getReplay(matchId, { limit = null } = {}) {
    const match = this._getMatch(matchId);
    const game = getGame(match.gameId);
    if (!game) throw new ArenaError('game_not_found', '这局使用的桌游插件已经不存在。', { status: 410 });
    try {
      const replay = buildReplay({ game, match, limit });
      replay.chat = filterVisible(match.chat, { role: 'observer', seat: null });
      replay.errors = match.errors;
      replay.result = match.result;
      replay.resultLabel = match.resultLabel;
      replay.modeLabel = match.modeLabel;
      replay.configSnapshot = match.configSnapshot;
      return replay;
    } catch (error) {
      throw new ArenaError('replay_corrupt', '这局回放无法重建，记录可能来自不兼容的规则版本。', {
        status: 500,
        details: error.message,
      });
    }
  }

  exportMatch(matchId) {
    const match = this._getMatch(matchId);
    const replay = this.getReplay(matchId);
    return {
      exportedAt: nowIso(),
      exporter: `AI Arena ${this.version}`,
      match: this.publicMatch(match),
      replay,
    };
  }

  async pingDafeiyu() {
    const settings = this.configStore.dafeiyuSettings();
    const client = this._makeDafeiyuClient(settings);
    return client.ping();
  }

  viewCount(matchId) {
    return this.hub.count(matchId);
  }

  async close() {
    this.closed = true;
    for (const [id, runtime] of this.runtimes) {
      this._clearSchedule(id);
      this._clearHealth(id);
      if (runtime.pending?.controller) runtime.pending.controller.abort();
      if (runtime.dafeiyu) {
        void runtime.dafeiyu.client.leave({
          sessionId: runtime.dafeiyu.sessionId,
          matchId: id,
        }).catch(() => {});
      }
    }
  }
}

export { KIND_LABELS };
