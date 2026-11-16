import {
  ArenaError,
  createId,
  createSeed,
  filterVisible,
  currentSeat,
  seatByOrder,
  seatDefinition,
} from '../../packages/core/index.mjs';
import {
  ModelError,
  requestModelCompletion,
  BuiltInBot,
} from '../../packages/models/index.mjs';
import { GAME_PLUGINS, listGames } from '../../packages/games/index.mjs';
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
  if (!outcome) return { result: null, resultLabel: null, winnerSeat: null, winnerName: null };
  if (outcome.type === 'win') {
    const seat = match.seats[outcome.winnerSeat];
    const label = outcome.winnerLabel || seat?.colorName || seat?.name || outcome.winnerSeat;
    return {
      result: 'win',
      resultLabel: `${label}${seat?.name && seat.name !== label ? ` · ${seat.name}` : ''} 获胜`,
      winnerSeat: outcome.winnerSeat,
      winnerName: seat?.name ?? outcome.winnerLabel ?? null,
    };
  }
  if (outcome.type === 'draw') return { result: 'draw', resultLabel: '和棋', winnerSeat: null, winnerName: null };
  if (outcome.type === 'aborted') {
    return { result: 'aborted', resultLabel: outcome.reason || '对局已结束', winnerSeat: null, winnerName: null };
  }
  return { result: outcome.type, resultLabel: outcome.type, winnerSeat: null, winnerName: null };
}

function resultGroup(value) {
  if (value === 'win' || value === 'black_win' || value === 'white_win') return 'win';
  if (value === 'draw') return 'draw';
  if (value === 'aborted') return 'aborted';
  return value || '';
}

function seatViewMap(game, state) {
  const views = {};
  for (const seat of game.seats) {
    try {
      views[seat.id] = game.getSeatView(state, seat.id);
    } catch {
      views[seat.id] = null;
    }
  }
  return views;
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
    gamePlugins = GAME_PLUGINS,
  }) {
    this.configStore = configStore;
    this.store = store;
    this.hub = hub;
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.gamePlugins = [...gamePlugins];
    this.gameMap = new Map(this.gamePlugins.map((game) => [game.id, game]));
    this.originProvider = originProvider
      ?? (() => `http://127.0.0.1:${this.configStore.server.port}`);
    this.version = version;
    this.matches = new Map();
    this.runtimes = new Map();
    this.closed = false;
    this.loadExisting();
  }

  _gameFor(matchOrId) {
    const gameId = typeof matchOrId === 'string' ? matchOrId : matchOrId?.gameId;
    return this.gameMap.get(gameId) ?? null;
  }

  _currentSeat(match) {
    const game = this._gameFor(match);
    if (!game) return null;
    return currentSeat(game, match.state);
  }

  _seatLabel(match, seatId) {
    return match.seats?.[seatId]?.colorName
      ?? match.seats?.[seatId]?.name
      ?? seatId
      ?? '未知座位';
  }

  _dafeiyuSeat(match) {
    return Object.values(match.seats ?? {}).find((seat) => seat.kind === 'dafeiyu') ?? null;
  }

  _seatList(match) {
    const game = this._gameFor(match);
    const order = Array.isArray(match.seatOrder) && match.seatOrder.length
      ? match.seatOrder
      : seatByOrder(game ?? { seats: Object.values(match.seats ?? {}) }).map((seat) => seat.id);
    return order.filter((id) => match.seats?.[id]).map((id) => match.seats[id]);
  }

  loadExisting() {
    const all = this.store.loadAll();
    for (const match of all) {
      let dirty = false;
      if (!match.chat) match.chat = [];
      if (!match.errors) match.errors = [];
      if (!match.events) match.events = [];
      if (!match.privateBySeat || typeof match.privateBySeat !== 'object') match.privateBySeat = {};
      if (!Array.isArray(match.randomEvents)) match.randomEvents = [];
      if (!Array.isArray(match.snapshots)) {
        match.snapshots = [];
        dirty = true;
      }
      if (!Array.isArray(match.actions)) match.actions = [];
      if (!Number.isInteger(match.revision)) match.revision = 0;
      if (!['playing', 'paused', 'finished', 'aborted'].includes(match.status)) {
        match.status = 'aborted';
        dirty = true;
      }
      const game = this._gameFor(match);
      if (game) {
        match.rulesText ??= game.rulesText;
        if (!Array.isArray(match.seatOrder) || !match.seatOrder.length) {
          match.seatOrder = seatByOrder(game).map((seat) => seat.id);
          dirty = true;
        }
      }
      for (const seat of Object.values(match.seats ?? {})) {
        if (['model', 'dafeiyu'].includes(seat.kind) && !seat.moveMode) {
          // 旧版本实际上没有候选/战术提示。
          seat.moveMode = 'pure';
          dirty = true;
        }
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
        match.resultGroup = 'aborted';
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
        dirty = true;
      }
      match.resultGroup = resultGroup(match.result);
      match.winnerSeat ??= match.outcome?.winnerSeat ?? null;
      match.winnerName ??= match.seats?.[match.winnerSeat]?.name
        ?? match.outcome?.winnerLabel
        ?? null;
      if (this._backfillSnapshots(match)) dirty = true;
      if (dirty) this.store.save(match);
      this.matches.set(match.id, match);
      this.runtimes.set(match.id, this.emptyRuntime(match));
    }
  }

  _backfillSnapshots(match) {
    const game = this._gameFor(match);
    if (!game) return false;
    if (match.rulesVersion !== game.rulesVersion) return false;
    if (Array.isArray(match.snapshots) && match.snapshots.length === match.actions.length + 1) {
      return false;
    }
    try {
      let state = game.createInitialState({ seed: match.seed });
      const snapshots = [{
        step: 0,
        at: match.createdAt ?? nowIso(),
        view: game.getPublicState(state),
        seatViews: seatViewMap(game, state),
      }];
      for (const entry of match.actions) {
        state = game.applyAction(state, entry.seat, entry.action).state;
        snapshots.push({
          step: snapshots.length,
          at: entry.at ?? nowIso(),
          view: game.getPublicState(state),
          seatViews: seatViewMap(game, state),
        });
      }
      match.snapshots = snapshots;
      return true;
    } catch (error) {
      this.logger.warn?.(`旧棋谱快照生成失败（${match.id}）：${error.message}`);
      return false;
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
      questionAbort: null,
      autoPendingKey: null,
      autoAbort: null,
      dafeiyuReleaseTimer: null,
      seenAutoKeys: seen,
      lastAutoCommentAt: match.dafeiyu?.lastCommentAt
        ? Date.parse(match.dafeiyu.lastCommentAt)
        : 0,
      archived: true,
    };
  }

  get games() {
    return listGames(this.gamePlugins);
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
      match.actions.map((action) => ({
        index: action.index,
        seat: action.seat,
        action: action.action,
        at: action.at,
        source: action.source,
        sourceName: action.sourceName,
        visibility: action.visibility ?? 'public',
        ...(action.clientActionId ? { clientActionId: action.clientActionId } : {}),
        ...(action.metrics ? { metrics: action.metrics } : {}),
        ...(action.modelMeta ? { modelMeta: action.modelMeta } : {}),
      })),
      viewer,
    );
  }

  _publicEvents(match, viewer) {
    return filterVisible(match.events ?? [], viewer).slice(-100).map((event) => ({
      seq: event.seq,
      at: event.at,
      step: event.step,
      type: event.type,
      visibility: event.visibility ?? 'public',
    }));
  }

  publicMatch(match, viewer = { role: 'observer', seat: null }) {
    if (!match) return null;
    const runtime = this._runtime(match.id);
    const game = this._gameFor(match);
    const controls = this._controls(match, runtime);
    const actions = this._visibleActions(match, viewer);
    const lastAction = actions.at(-1) ?? null;
    const current = this._currentSeat(match);
    let state = null;
    if (game) {
      try {
        state = viewer.seat
          ? game.getSeatView(match.state, viewer.seat)
          : game.getPublicState(match.state);
      } catch (error) {
        this.logger.warn?.(`公开局面生成失败：${error.message}`);
      }
    }
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
      resultGroup: resultGroup(match.result),
      resultLabel: match.resultLabel,
      winnerSeat: match.winnerSeat ?? match.outcome?.winnerSeat ?? null,
      winnerName: match.winnerName ?? null,
      outcome: match.outcome,
      seats: match.seats,
      seatOrder: this._seatList(match).map((seat) => seat.id),
      state,
      turnSeat: current,
      turnSeatName: current ? this._seatLabel(match, current) : null,
      actions,
      actionCount: match.actions.length,
      lastAction,
      lastActionText: lastAction && game?.describeAction
        ? game.describeAction(lastAction.action)
        : lastAction?.action?.move ?? null,
      chat: filterVisible(match.chat, viewer),
      errors: match.errors.slice(-50),
      events: this._publicEvents(match, viewer),
      pause: match.pause,
      pending: match.pending,
      dafeiyu: {
        ...match.dafeiyu,
        playerSeat: this._dafeiyuSeat(match)?.id ?? null,
        busy: Boolean(runtime?.dafeiyuBusy || runtime?.autoPendingKey),
        askBlockedReason: controls?.askBlockedReason ?? null,
        viewers: this.hub.count(match.id),
      },
      controls,
      viewers: this.hub.count(match.id),
      game: game ? {
        id: game.id,
        name: game.name,
        rulesVersion: game.rulesVersion,
        rulesText: game.rulesText,
        seats: seatByOrder(game).map((seat) => ({
          id: seat.id,
          name: seat.name,
          shortName: seat.shortName ?? seat.name.slice(0, 1),
          color: seat.color ?? null,
          order: seat.order ?? 0,
        })),
        ui: game.ui ?? null,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
      } : null,
      configSnapshot: match.configSnapshot,
      recovered: Boolean(match.recovered),
      archived: Boolean(runtime?.archived),
    };
  }

  _hasDafeiyuSeat(match) {
    return Boolean(this._dafeiyuSeat(match));
  }

  _allAi(match) {
    return !Object.values(match.seats).some((seat) => seat.kind === 'human');
  }

  _controls(match, runtime) {
    const active = match.status === 'playing' || match.status === 'paused';
    const paused = match.status === 'paused';
    const humanSeat = Object.values(match.seats).find((seat) => seat.kind === 'human');
    const dafeiyuSeat = this._dafeiyuSeat(match);
    const current = this._currentSeat(match);
    const pausedCode = match.pause?.code ?? '';
    const canReconnect = match.dafeiyu?.enabled
      && match.dafeiyu.status !== 'connected'
      && Boolean(runtime)
      && !runtime.archived;
    let askBlockedReason = null;
    if (!match.dafeiyu?.enabled) askBlockedReason = '大肥鱼没有连接到这局。';
    else if (match.dafeiyu.status !== 'connected') askBlockedReason = '大肥鱼未连接，请先重新连接。';
    else if (runtime?.pending && dafeiyuSeat && runtime.pending.seat === dafeiyuSeat.id && runtime.pending.kind === 'dafeiyu') {
      askBlockedReason = '大肥鱼正在落子，请等这一手完成再问。';
    } else if (match.status === 'playing' && dafeiyuSeat && current === dafeiyuSeat.id) {
      askBlockedReason = '轮到本局大肥鱼落子，请等这一手完成再问。';
    } else if (runtime?.dafeiyuBusy) {
      askBlockedReason = '大肥鱼正在回答上一个问题，请稍候。';
    } else if (!runtime || runtime.archived) {
      askBlockedReason = '对局归档后不能提问。';
    }
    return {
      canPause: match.status === 'playing',
      canResume: paused && match.pause?.resumeable !== false && Boolean(runtime) && !runtime.archived,
      canStep: paused
        && this._allAi(match)
        && !runtime?.pending
        && Boolean(runtime)
        && !runtime.archived,
      canRetry: paused
        && ['model_error', 'model_timeout', 'model_busy', 'ai_invalid_move', 'dafeiyu_error', 'dafeiyu_busy',
          'dafeiyu_timeout', 'dafeiyu_invalid_move', 'dafeiyu_output_invalid', 'dafeiyu_model_error',
          'dafeiyu_disconnected', 'step_failed'].includes(pausedCode)
        && Boolean(runtime)
        && !runtime.archived,
      canEnd: active,
      canAskDafeiyu: !askBlockedReason,
      askBlockedReason,
      canReconnect,
      canToggleDafeiyu: !this._hasDafeiyuSeat(match) && Boolean(runtime) && !runtime.archived,
      humanSeat: humanSeat?.id ?? null,
      isHumanTurn: humanSeat?.id === current && match.status === 'playing',
      turnSeat: current,
      turnSeatName: current ? this._seatLabel(match, current) : null,
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

  _createSeat(game, seatId, input, runtime, defaultMoveMode = 'assisted') {
    const kind = input?.kind;
    const def = seatDefinition(game, seatId);
    if (!def) throw new ArenaError('invalid_seat', `未知座位：${seatId}。`);
    if (!KIND_LABELS[kind]) {
      throw new ArenaError('invalid_seat', `${def.name} 的座位类型无效。`);
    }
    const requestedMode = input?.moveMode === 'pure' || input?.moveMode === 'assisted'
      ? input.moveMode
      : null;
    const moveMode = ['model', 'dafeiyu'].includes(kind)
      ? (requestedMode ?? (defaultMoveMode === 'pure' ? 'pure' : 'assisted'))
      : null;
    const base = {
      id: seatId,
      side: seatId,
      kind,
      order: def.order ?? 0,
      colorName: def.name,
      shortName: def.shortName ?? def.name,
      color: def.color ?? null,
      moveMode,
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
        engineLabel: '大肥鱼 · 桌宠棋手',
        provider: 'dafeiyu',
      };
    }
    if (kind === 'model') {
      if (typeof input.modelId !== 'string' || !input.modelId) {
        throw new ArenaError('invalid_seat', `${def.name} 选择了模型，但没有指定模型配置。`);
      }
      const model = this.configStore.modelConfig(input.modelId);
      if (!model) {
        throw new ArenaError('model_not_found', `${def.name} 使用的模型配置已不存在。`, { status: 404 });
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
    throw new ArenaError('invalid_seat', `${def.name} 的座位类型无效。`);
  }

  _modeLabel(game, seats) {
    const ordered = seatByOrder(game).map((def) => seats[def.id]).filter(Boolean);
    const human = ordered.find((seat) => seat.kind === 'human');
    if (!human) {
      const names = ordered.map((seat) => seat.name).join(' / ');
      return `${ordered.map((seat) => seat.colorName).join(' · ')}｜全 AI 观战｜${names}`;
    }
    const opponents = ordered.filter((seat) => seat.kind !== 'human');
    return `真人 · ${human.colorName} 对 ${opponents.map((seat) => `${seat.colorName} ${seat.name}`).join(' / ')}`;
  }

  _snapshotFor(match) {
    const game = this._gameFor(match);
    if (!game) return null;
    return {
      step: match.actions.length,
      at: nowIso(),
      seed: match.seed ?? null,
      // 未来发牌/掷骰把公开随机结果追加到 match.randomEvents，快照会随步骤保存。
      randomEvents: Array.isArray(match.randomEvents) ? match.randomEvents.slice() : [],
      view: game.getPublicState(match.state),
      seatViews: seatViewMap(game, match.state),
    };
  }

  async createMatch(payload = {}) {
    if (this.closed) throw new ArenaError('server_closed', '服务正在关闭。', { status: 503 });
    const game = this.gameMap.get(payload.gameId);
    if (!game) {
      throw new ArenaError('game_not_found', '未找到这个桌游插件。', { status: 404 });
    }
    const defs = seatByOrder(game);
    let rawSeats = payload.seats;
    if (Array.isArray(rawSeats)) {
      rawSeats = Object.fromEntries(rawSeats.filter((seat) => seat?.id).map((seat) => [seat.id, seat]));
    }
    if (!rawSeats && (payload.black || payload.white)) {
      rawSeats = { black: payload.black, white: payload.white };
    }
    if (!rawSeats || typeof rawSeats !== 'object') {
      throw new ArenaError('invalid_seats', `请配置全部座位：${defs.map((seat) => seat.name).join('、')}。`);
    }
    const unknown = Object.keys(rawSeats).filter((id) => !defs.some((seat) => seat.id === id));
    if (unknown.length) {
      throw new ArenaError('invalid_seats', `这个桌游没有座位：${unknown.join('、')}。`);
    }
    const missing = defs.filter((seat) => !rawSeats[seat.id]);
    if (missing.length) {
      throw new ArenaError(
        'invalid_seats',
        `请为全部座位选择角色：${missing.map((seat) => seat.name).join('、')}。`,
      );
    }
    const runtime = {
      epoch: 0,
      pending: null,
      stepOnce: false,
      scheduleTimer: null,
      modelConfigs: {},
      dafeiyu: null,
      dafeiyuBusy: false,
      questionAbort: null,
      autoPendingKey: null,
      autoAbort: null,
      seenAutoKeys: new Set(),
      lastAutoCommentAt: 0,
      dafeiyuReleaseTimer: null,
      archived: false,
    };
    const seats = {};
    for (const def of defs) {
      seats[def.id] = this._createSeat(game, def.id, rawSeats[def.id], runtime, payload.moveMode);
    }
    if (Object.values(seats).filter((seat) => seat.kind === 'human').length > 1) {
      throw new ArenaError('invalid_seats', '当前版本一局只支持一位真人座位。', {
        details: ['可以一位真人，其余座位使用模型、内置机器人或大肥鱼。'],
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
    if (dafeiyuEnabled) await this._releaseTerminalDafeiyuSessions();
    const now = nowIso();
    const seed = createSeed();
    const initialState = game.createInitialState({ seed });
    const match = {
      schemaVersion: 2,
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
      modeLabel: this._modeLabel(game, seats),
      seats,
      seatOrder: defs.map((seat) => seat.id),
      state: initialState,
      snapshots: [],
      actions: [],
      chat: [],
      errors: [],
      events: [],
      pause: null,
      pending: null,
      outcome: null,
      result: null,
      resultGroup: null,
      resultLabel: null,
      winnerSeat: null,
      winnerName: null,
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
        game: {
          id: game.id,
          name: game.name,
          rulesVersion: game.rulesVersion,
          minPlayers: game.minPlayers,
          maxPlayers: game.maxPlayers,
          seats: defs.map((seat) => ({ id: seat.id, name: seat.name, color: seat.color ?? null })),
        },
        seats: Object.fromEntries(
          Object.entries(seats).map(([id, seat]) => [id, {
            kind: seat.kind,
            name: seat.name,
            colorName: seat.colorName,
            moveMode: seat.moveMode ?? null,
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
    match.snapshots.push(this._snapshotFor(match));
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
    const current = this._currentSeat(match);
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
      if (!(error instanceof DafeiyuError)) {
        this.logger.warn?.(`连接大肥鱼内部错误：${error?.stack ?? error?.message ?? error}`);
      }
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
    this._abortAutoComment(match, '大肥鱼连接异常');
    this._abortDafeiyuQuestion(match, '大肥鱼连接异常');
    this._cancelDafeiyuSpeech(match);
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
    const seatId = this._currentSeat(match);
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
    if (this._currentSeat(match) !== context.seat) return false;
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
    const seat = this._currentSeat(match);
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
    if (seatConfig.kind === 'dafeiyu') {
      // 桥接层也会执行优先级，这里先撤掉本局低优先级点评，避免旧回答回写。
      this._abortAutoComment(match, '轮到棋手落子，自动点评让位');
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
      startedAt: Date.now(),
      failures: [],
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

  _assistedContext(game, state, seatId) {
    let hints = {};
    if (typeof game.getTacticalHints === 'function') {
      try {
        hints = game.getTacticalHints({ state, seatId }) ?? {};
      } catch (error) {
        this.logger.warn?.(`战术提示生成失败：${error.message}`);
      }
    }
    let legalActions = hints.legalActions;
    if (!Array.isArray(legalActions) && typeof game.legalActions === 'function') {
      try {
        legalActions = game.legalActions(state, seatId);
      } catch {
        legalActions = [];
      }
    }
    return {
      legalActions: Array.isArray(legalActions) ? legalActions.slice(0, 300) : [],
      immediateWins: Array.isArray(hints.immediateWins) ? hints.immediateWins : [],
      mustBlocks: Array.isArray(hints.mustBlocks) ? hints.mustBlocks : [],
      doubleThreatMoves: Array.isArray(hints.doubleThreatMoves) ? hints.doubleThreatMoves : [],
      notes: Array.isArray(hints.notes) ? hints.notes.slice(0, 8) : [],
    };
  }

  _modelMoveDescription(match, game, seatId, mode) {
    const description = game.describeForModel({
      state: match.state,
      seatId,
      mode,
      recentActions: match.actions.slice(-8),
    });
    const assisted = mode === 'assisted' ? this._assistedContext(game, match.state, seatId) : null;
    return { description, assisted };
  }

  async _requestAiAction(match, context) {
    const runtime = this._runtime(match.id);
    const seatConfig = match.seats[context.seat];
    const game = this._gameFor(match);
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
      const mode = seatConfig.moveMode === 'assisted' ? 'assisted' : 'pure';
      const { description, assisted } = this._modelMoveDescription(match, game, context.seat, mode);
      const visibleSeat = match.seats[context.seat] ?? {};
      const seatLabel = visibleSeat.colorName || description.seatLabel || context.seat;
      const messages = [
        {
          role: 'system',
          content: [
            `你是「${config.name}」，正在 AI Arena 中执${seatLabel}（座位 ${context.seat}，${visibleSeat.name || ''}）。`,
            '严格依据给定规则、局面和动作格式行动；只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要解释过程。',
            `必须使用的动作格式：${description.responseFormat || '{"move":"..."}'}`,
            mode === 'assisted'
              ? '这是规则辅助模式：可以参考提供了合法候选、立即成五点和必堵点，但最终仍必须给出一个合法动作。'
              : '这是纯模型模式：没有额外的合法候选或战术提示，请自行判断。',
            description.rulesText || game.rulesText || '',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `当前局面：\n${description.boardText ?? JSON.stringify(description.state ?? {})}`,
            game.coordinateSystem
              ? `坐标：列 ${game.coordinateSystem.columns}；行 ${game.coordinateSystem.rows}。`
              : '',
            `本回合由 ${seatLabel} 行动。最近落子：${JSON.stringify(description.lastMove ?? null)}`,
            description.privateContext
              ? `你的座位可见信息：\n${JSON.stringify(description.privateContext)}`
              : '',
            assisted ? `规则辅助信息：\n${JSON.stringify(assisted)}` : '',
            context.feedback ? `上一次提交无效：${context.feedback}\n请重新给出一个完整合法动作。` : '',
            '现在只返回一个合法 JSON 对象。',
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
        mode: seatConfig.moveMode ?? 'pure',
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
        throw new DafeiyuError('model_invalid_content', parsed.error, { retryable: true });
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

  _aiErrorCode(error, seatKind, { phase = 'request' } = {}) {
    if (seatKind === 'dafeiyu') {
      const code = error?.code;
      if (phase === 'validation') return 'dafeiyu_invalid_move';
      if (error?.status === 429 || ['busy', 'model_busy', 'player_busy', 'question_busy', 'comment_skipped', 'player_priority'].includes(code)) {
        return 'dafeiyu_busy';
      }
      if (code === 'timeout' || code === 'model_timeout') return 'dafeiyu_timeout';
      if (['unreachable', 'auth', 'forbidden', 'unsupported', 'session_expired', 'session_conflict', 'session_limit', 'dafeiyu_disconnected'].includes(code)) {
        return 'dafeiyu_disconnected';
      }
      if (['model_invalid_content', 'model_invalid', 'ai_invalid_move', 'invalid_response'].includes(code)) {
        return 'dafeiyu_output_invalid';
      }
      if (['model_error', 'model_empty', 'model_auth'].includes(code)) return 'dafeiyu_model_error';
      return 'dafeiyu_error';
    }
    if (phase === 'validation' || error?.code === 'ai_invalid_move') return 'ai_invalid_move';
    if (error?.code === 'timeout') return 'model_timeout';
    if (['rate_limited', 'model_busy'].includes(error?.code)) return 'model_busy';
    if (error?.code === 'cancelled') return 'cancelled';
    return 'model_error';
  }

  async _runAiTurn(match, context, maxAttempts) {
    const runtime = this._runtime(match.id);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this._isActiveRequest(match, runtime, context)) return;
      runtime.pending.attempt = attempt;
      const seatConfigNow = match.seats[context.seat];
      const seatLabel = seatConfigNow.colorName || seatConfigNow.name;
      const kind = seatConfigNow.kind;
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
        const code = this._aiErrorCode(error, seatKind);
        context.failures.push({ code, message: compactText(error?.message ?? '未知错误', 300) });
        const retryableCodes = new Set([
          'dafeiyu_output_invalid',
          'dafeiyu_timeout',
          'ai_invalid_move',
          'model_error',
          'model_timeout',
        ]);
        const retryable = error?.retryable !== false
          && retryableCodes.has(code)
          && error?.code !== 'cancelled'
          && attempt < maxAttempts;
        if (retryable) {
          context.feedback = error?.message ?? '上一次落子无效。';
          await sleep(120);
          continue;
        }
        if (seatKind === 'dafeiyu' && code === 'dafeiyu_disconnected') {
          this._markDafeiyuDisconnected(match, error, '大肥鱼棋手请求失败');
        }
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
      const game = this._gameFor(match);
      const validation = game.validateAction(match.state, context.seat, result.action);
      if (!validation.ok) {
        const code = this._aiErrorCode(new Error(validation.message), match.seats[context.seat].kind, { phase: 'validation' });
        context.failures.push({ code, message: validation.message });
        if (attempt < maxAttempts) {
          context.feedback = validation.message;
          await sleep(120);
          continue;
        }
        this._recordError(match, {
          code,
          message: validation.message,
          seat: context.seat,
          source: match.seats[context.seat].kind,
        });
        this._failAiTurn(match, context, {
          code,
          reason: `${seatLabel}连续返回了非法落子：${validation.message}`,
          attempts: attempt,
        });
        return;
      }
      const finishedAt = Date.now();
      await this._commitAiAction(match, context, {
        ...result,
        action: validation.action,
        metrics: {
          attempts: attempt,
          failures: context.failures.slice(0, 10),
          elapsedMs: Math.max(0, finishedAt - context.startedAt),
          moveMode: match.seats[context.seat].moveMode ?? null,
        },
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
      metrics: result.metrics ?? null,
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
      const nextSeat = this._currentSeat(match);
      if (nextSeat && match.seats[nextSeat].kind !== 'human') {
        this._scheduleAi(match);
      }
    }
    if (match.status === 'finished') {
      this._clearHealth(match.id);
      this._scheduleDafeiyuRelease(match);
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
    metrics = null,
    say = '',
  }) {
    const game = this._gameFor(match);
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
      ...(metrics ? { metrics } : {}),
      event: applied.event ?? null,
    };
    match.actions.push(entry);
    match.state = applied.state;
    match.lastActionAt = at;
    match.snapshots ??= [];
    match.snapshots.push(this._snapshotFor(match));
    this._event(match, 'move', {
      seat,
      seatLabel: this._seatLabel(match, seat),
      source,
      sourceName,
      action,
      move: action?.move ?? null,
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
      match.resultGroup = resultGroup(result.result);
      match.resultLabel = result.resultLabel;
      match.winnerSeat = result.winnerSeat;
      match.winnerName = result.winnerName;
      match.status = 'finished';
      match.finishedAt = at;
      match.pause = null;
      this._event(match, 'match_finished', {
        result: match.result,
        resultLabel: match.resultLabel,
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
    const current = this._currentSeat(match);
    if (current !== seat) {
      throw new ArenaError('wrong_turn', `现在轮到${this._seatLabel(match, current)}。`, {
        status: 409,
      });
    }
    const game = this._gameFor(match);
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
      metrics: {
        attempts: 1,
        failures: [],
        elapsedMs: 0,
        moveMode: null,
      },
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
    const nextSeat = this._currentSeat(match);
    if (match.status === 'playing' && nextSeat && match.seats[nextSeat].kind !== 'human') {
      this._scheduleAi(match);
    }
    if (match.status === 'finished') {
      this._clearHealth(match.id);
      this._scheduleDafeiyuRelease(match);
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
    this._abortAutoComment(match, '对局暂停，自动点评取消');
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
    const current = this._currentSeat(match);
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
    const seat = this._currentSeat(match);
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
      'model_busy',
      'model_timeout',
      'ai_invalid_move',
      'dafeiyu_model_error',
      'dafeiyu_error',
      'dafeiyu_busy',
      'dafeiyu_timeout',
      'dafeiyu_invalid_move',
      'dafeiyu_output_invalid',
      'dafeiyu_model_error',
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
    this._abortAutoComment(match, '用户结束对局');
    this._abortDafeiyuQuestion(match, '用户结束对局');
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
    match.resultGroup = 'aborted';
    match.resultLabel = '用户结束对局';
    match.winnerSeat = null;
    match.winnerName = null;
    match.pause = null;
    this._event(match, 'match_ended', { reason: match.outcome.reason });
    this._clearHealth(matchId);
    this._cancelDafeiyuSpeech(match);
    this._scheduleDafeiyuRelease(match, { delayMs: 3000 });
    this._persist(match);
    return this.publicMatch(match);
  }

  _integrationSnapshot(match, { role, seat = null, turn = null, mode = 'pure' }) {
    const game = this._gameFor(match);
    if (!game) throw new ArenaError('game_not_found', '找不到这局使用的桌游。', { status: 404 });
    const viewer = { role, seat };
    const visibleActions = filterVisible(match.actions, viewer);
    const current = this._currentSeat(match);
    const seatId = seat ?? turn ?? current ?? game.seats[0]?.id ?? null;
    const view = role === 'player' && seat
      ? game.getSeatView(match.state, seat)
      : game.getPublicState(match.state);
    const { description, assisted } = this._modelMoveDescription(match, game, seatId, mode);
    const seatLabel = seatId ? this._seatLabel(match, seatId) : null;
    return {
      protocolVersion: 2,
      matchId: match.id,
      role,
      seat,
      seatLabel,
      seats: seatByOrder(game).map((def) => ({
        id: def.id,
        name: def.name,
        colorName: match.seats[def.id]?.colorName ?? def.name,
        kind: match.seats[def.id]?.kind ?? null,
      })),
      game: {
        id: match.gameId,
        name: match.gameName,
        rulesVersion: match.rulesVersion,
        rulesText: game.rulesText,
        coordinateSystem: game.coordinateSystem,
        actionFormat: description.responseFormat || '{"move":"..."}',
        moveMode: mode,
      },
      moveMode: mode,
      assisted: mode === 'assisted' ? assisted : null,
      turn: current,
      turnSeatName: current ? this._seatLabel(match, current) : null,
      moveCount: match.actions.length,
      state: view,
      outcome: match.outcome,
      recentActions: visibleActions.slice(-8).map((entry) => ({
        index: entry.index,
        seat: entry.seat,
        source: entry.source,
        action: entry.action,
        text: game.describeAction ? game.describeAction(entry.action) : entry.action?.move ?? null,
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

  _abortAutoComment(match, reason = '低优先级点评已取消') {
    const runtime = this._runtime(match.id);
    if (!runtime?.autoAbort) return;
    runtime.autoAbort.abort();
    runtime.autoAbort = null;
    runtime.autoPendingKey = null;
    this._event(match, 'auto_comment_cancelled', { reason });
  }

  async _maybeAutoComment(match, candidates) {
    if (!match.dafeiyu.enabled || !match.dafeiyu.autoComment) return;
    if (match.dafeiyu.status !== 'connected') return;
    if (this.hub.count(match.id) < 1) return;
    const runtime = this._runtime(match.id);
    if (!runtime?.dafeiyu || runtime.autoPendingKey) return;
    // 落子优先：轮到入座的大肥鱼时，不启动任何低优先级点评。
    const current = this._currentSeat(match);
    const dafeiyuSeat = this._dafeiyuSeat(match);
    if (dafeiyuSeat && (runtime.pending?.kind === 'dafeiyu' || current === dafeiyuSeat.id)) {
      this._event(match, 'auto_comment_deferred', {
        reason: '轮到本局大肥鱼棋手落子',
      });
      return;
    }
    if (current && match.seats[current]?.kind === 'dafeiyu') return;
    if (runtime.dafeiyuBusy) return;
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
    const dafeiyuSeat = this._dafeiyuSeat(match);
    const role = dafeiyuSeat ? 'player' : 'observer';
    const seat = dafeiyuSeat?.id ?? null;
    const stepAtRequest = match.actions.length;
    const controller = new AbortController();
    if (runtime) runtime.autoAbort = controller;
    try {
      const snapshot = this._integrationSnapshot(match, {
        role,
        seat,
        turn: this._currentSeat(match),
        mode: dafeiyuSeat?.moveMode ?? 'pure',
      });
      const response = await session.client.comment({
        sessionId: session.sessionId,
        matchId: match.id,
        role,
        seat,
        snapshot,
        event: {
          key: candidate.key,
          type: candidate.type,
          summary: candidate.summary,
          details: candidate.details ?? null,
        },
        mode: 'auto',
        signal: controller.signal,
      });
      if (this.hub.count(match.id) < 1) return;
      if (match.status === 'aborted') return;
      if (!match.dafeiyu.enabled || !match.dafeiyu.autoComment) return;
      if (match.dafeiyu.status !== 'connected') return;
      if (runtime?.dafeiyu?.sessionId !== session.sessionId) return;
      // 非终局点评一旦棋局前进了，就丢弃旧局面的点评。
      if (!AUTO_PRIORITY.has(candidate.type) && match.actions.length !== stepAtRequest) return;
      const current = this._currentSeat(match);
      if (dafeiyuSeat && current === dafeiyuSeat.id && !AUTO_PRIORITY.has(candidate.type)) return;
      const text = compactText(response.text, 180);
      if (!text) return;
      if (this._seenAutoKeys(match, runtime).has(candidate.key)) return;
      const chat = this._addChat(match, {
        role: 'dafeiyu',
        text,
        kind: 'comment',
        seat,
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
      const expected = [
        'cancelled', 'comment_skipped', 'player_priority', 'model_busy',
        'player_busy', 'question_busy', 'session_expired', 'session_conflict',
      ].includes(publicError.code);
      if (expected) {
        this.logger.info?.(`自动点评让位或过时（${match.id}）：${publicError.code}`);
      } else {
        // 后台点评失败不是棋手掉线：只记录错误，不改变连接和暂停状态。
        this._recordError(match, {
          code: publicError.code,
          message: publicError.message,
          source: 'dafeiyu_comment',
        });
        this._persist(match);
      }
    } finally {
      if (runtime) {
        if (runtime.autoPendingKey === candidate.key) runtime.autoPendingKey = null;
        if (runtime.autoAbort === controller) runtime.autoAbort = null;
      }
      if (match.status === 'finished' || match.status === 'aborted') {
        this._scheduleDafeiyuRelease(match, { delayMs: 5000 });
      }
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
    const dafeiyuSeat = this._dafeiyuSeat(match);
    const current = this._currentSeat(match);
    if (runtime.pending?.kind === 'dafeiyu'
      || (match.status === 'playing' && dafeiyuSeat && current === dafeiyuSeat.id)) {
      throw new ArenaError('dafeiyu_busy', '大肥鱼正在落子，请等这一手完成再问。', {
        status: 429,
        details: { retryAfterMs: 800 },
      });
    }
    if (voice !== null && typeof voice === 'boolean') {
      match.dafeiyu.voice = voice;
    }
    runtime.dafeiyuBusy = true;
    const questionController = new AbortController();
    runtime.questionAbort = questionController;
    this._addChat(match, { role: 'user', text: question, kind: 'question' });
    this._persist(match);
    const session = runtime.dafeiyu;
    const role = dafeiyuSeat ? 'player' : 'observer';
    const seat = dafeiyuSeat?.id ?? null;
    try {
      const snapshot = this._integrationSnapshot(match, {
        role,
        seat,
        turn: current,
        mode: dafeiyuSeat?.moveMode ?? 'pure',
      });
      const response = await session.client.question({
        sessionId: session.sessionId,
        matchId: match.id,
        role,
        seat,
        snapshot,
        question,
        signal: questionController.signal,
      });
      if (runtime.dafeiyu?.sessionId !== session.sessionId
        || runtime.questionAbort !== questionController
        || match.status === 'aborted') {
        throw new DafeiyuError('cancelled', '旧局或旧会话的回答已作废。', { retryable: false });
      }
      const answer = compactText(response.text, 600);
      if (!answer) {
        throw new DafeiyuError('model_empty', '大肥鱼没有返回可显示的答复。');
      }
      const chat = this._addChat(match, {
        role: 'dafeiyu',
        text: answer,
        kind: 'answer',
        seat,
        authorName: match.dafeiyu.personaName || '大肥鱼',
        voiceStatus: match.dafeiyu.voice ? 'queued' : 'off',
      });
      this._event(match, 'dafeiyu_answer', { length: answer.length });
      runtime.dafeiyuBusy = false;
      if (runtime.questionAbort === questionController) runtime.questionAbort = null;
      this._persist(match);
      if (match.dafeiyu.voice && chat) {
        void this._speakDafeiyu(match, answer, `answer:${match.id}:${chat.id}`, chat.id);
      }
      return this.publicMatch(match);
    } catch (error) {
      runtime.dafeiyuBusy = false;
      if (runtime.questionAbort === questionController) runtime.questionAbort = null;
      const publicError = error instanceof DafeiyuError
        ? error.toPublic()
        : { code: 'dafeiyu_question_error', message: '大肥鱼暂时没有回答。' };
      const busy = error?.status === 429
        || ['player_busy', 'question_busy', 'model_busy', 'player_priority', 'comment_skipped'].includes(publicError.code);
      const cancelled = publicError.code === 'cancelled' || publicError.code === 'session_expired';
      const disconnected = ['unreachable', 'auth', 'forbidden', 'unsupported', 'session_conflict', 'session_limit'].includes(publicError.code);
      const timeout = publicError.code === 'timeout' || publicError.code === 'model_timeout';
      if (disconnected) {
        this._markDafeiyuDisconnected(match, error, '大肥鱼连接异常');
      }
      if (!busy && !cancelled) {
        this._recordError(match, {
          code: timeout ? 'dafeiyu_timeout' : publicError.code,
          message: publicError.message,
          source: 'dafeiyu_question',
        });
      }
      this._persist(match);
      if (cancelled) {
        throw new ArenaError('dafeiyu_cancelled', '这次回答属于已释放的旧会话，已作废。', {
          status: 409,
          details: publicError,
        });
      }
      if (busy) {
        throw new ArenaError('dafeiyu_busy', publicError.message || '大肥鱼正在落子，请稍后再问。', {
          status: 429,
          details: publicError,
        });
      }
      if (timeout) {
        throw new ArenaError('dafeiyu_timeout', '大肥鱼思考超时，请稍后再试。', {
          status: 504,
          details: publicError,
        });
      }
      if (disconnected) {
        throw new ArenaError('dafeiyu_disconnected', publicError.message, {
          status: 503,
          details: publicError,
        });
      }
      throw new ArenaError('dafeiyu_error', publicError.message, {
        status: 502,
        details: publicError,
      });
    }
  }

  _abortDafeiyuQuestion(match, reason = '旧会话已释放') {
    const runtime = this._runtime(match.id);
    if (!runtime?.questionAbort) return false;
    runtime.questionAbort.abort();
    runtime.questionAbort = null;
    runtime.dafeiyuBusy = false;
    this._event(match, 'dafeiyu_question_cancelled', { reason });
    return true;
  }

  _cancelDafeiyuSpeech(match) {
    const runtime = this._runtime(match.id);
    let changed = false;
    for (const chat of match.chat ?? []) {
      if (chat.voiceStatus === 'queued') {
        chat.voiceStatus = 'cancelled';
        changed = true;
      }
    }
    if (runtime?.dafeiyu) {
      void runtime.dafeiyu.client.cancelSpeech({
        sessionId: runtime.dafeiyu.sessionId,
        matchId: match.id,
      }).catch(() => {});
    }
    return changed;
  }

  _scheduleDafeiyuRelease(match, { delayMs = null } = {}) {
    if (this.closed || !match.dafeiyu?.enabled) return;
    if (match.status !== 'finished' && match.status !== 'aborted') return;
    const runtime = this._runtime(match.id);
    if (!runtime?.dafeiyu) return;
    if (runtime.dafeiyuReleaseTimer) clearTimeout(runtime.dafeiyuReleaseTimer);
    const wait = delayMs ?? Math.max(
      5000,
      Number(this.configStore.dafeiyuSettings().sessionReleaseMs) || 20000,
    );
    runtime.dafeiyuReleaseTimer = setTimeout(() => {
      runtime.dafeiyuReleaseTimer = null;
      void this._releaseDafeiyuSession(match.id);
    }, wait);
    runtime.dafeiyuReleaseTimer.unref?.();
  }

  async _releaseDafeiyuSession(matchId) {
    const match = this.matches.get(matchId);
    const runtime = this._runtime(matchId);
    if (!match || !runtime?.dafeiyu) return;
    if (match.status !== 'finished' && match.status !== 'aborted') return;
    if (runtime.autoPendingKey) {
      this._scheduleDafeiyuRelease(match, { delayMs: 4000 });
      return;
    }
    const changed = this._cancelDafeiyuSpeech(match);
    await this._disconnectDafeiyuSession(match);
    match.dafeiyu.status = 'disconnected';
    match.dafeiyu.releasedAt = nowIso();
    this._event(match, 'dafeiyu_session_released', { reason: '终局后释放桌宠会话' });
    if (changed) this._persist(match);
    else this._persist(match);
  }

  async _releaseTerminalDafeiyuSessions() {
    const tasks = [];
    for (const match of this.matches.values()) {
      if (match.status !== 'finished' && match.status !== 'aborted') continue;
      const runtime = this._runtime(match.id);
      if (!runtime?.dafeiyu) continue;
      tasks.push((async () => {
        if (runtime.dafeiyuReleaseTimer) {
          clearTimeout(runtime.dafeiyuReleaseTimer);
          runtime.dafeiyuReleaseTimer = null;
        }
        this._cancelDafeiyuSpeech(match);
        await this._disconnectDafeiyuSession(match);
        match.dafeiyu.status = 'disconnected';
        this._persist(match);
      })());
    }
    if (tasks.length) await Promise.allSettled(tasks);
  }

  async leaveMatch(matchId, { reason = '离开对局页面' } = {}) {
    const match = this._getMatch(matchId);
    const runtime = this._runtime(matchId);
    if (!runtime) return this.publicMatch(match);
    this._abortAutoComment(match, reason);
    this._abortDafeiyuQuestion(match, reason);
    if (match.status === 'playing' && this._hasDafeiyuSeat(match)) {
      this._pauseMatch(match, {
        code: 'page_left',
        reason: '已离开对局页面，大肥鱼会话已释放。返回后点“重新连接”，再继续。',
        resumeable: true,
      });
    }
    this._cancelDafeiyuSpeech(match);
    if (match.dafeiyu.enabled) {
      await this._disconnectDafeiyuSession(match);
      match.dafeiyu.status = 'disconnected';
    }
    this._event(match, 'viewer_left', { reason: compactText(reason, 120) });
    this._persist(match);
    return this.publicMatch(match);
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
    if (patch.autoComment === false) this._abortAutoComment(match, '自动点评已由用户关闭');
    if (patch.autoComment != null) match.dafeiyu.autoComment = Boolean(patch.autoComment);
    if (patch.voice === false && match.dafeiyu.voice) {
      this._cancelDafeiyuSpeech(match);
    }
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
    this._abortAutoComment(match, '桌宠会话关闭');
    this._abortDafeiyuQuestion(match, '桌宠会话关闭');
    if (runtime?.dafeiyuReleaseTimer) {
      clearTimeout(runtime.dafeiyuReleaseTimer);
      runtime.dafeiyuReleaseTimer = null;
    }
    this._cancelDafeiyuSpeech(match);
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

  listMatches({ player = '', result = '', status = '', game = '', q = '' } = {}) {
    const playerText = String(player ?? '').trim().toLowerCase();
    const resultText = String(result ?? '').trim();
    const wantedGroup = resultGroup(resultText) || resultText;
    const statusText = String(status ?? '').trim();
    const gameText = String(game ?? '').trim();
    const query = String(q ?? '').trim().toLowerCase();
    return this.store.list().filter((item) => {
      if (wantedGroup && resultGroup(item.result) !== wantedGroup && item.result !== resultText) return false;
      if (statusText && item.status !== statusText) return false;
      if (gameText && item.gameId !== gameText) return false;
      const seats = Object.values(item.seats ?? {});
      const players = seats.map((seat) => `${seat.name} ${seat.engineLabel} ${seat.modelName ?? ''} ${seat.moveMode ?? ''}`).join(' ').toLowerCase();
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
    const game = this._gameFor(match);
    if (!game) throw new ArenaError('game_not_found', '这局使用的桌游插件已经不存在。', { status: 410 });
    if (!Array.isArray(match.snapshots) || match.snapshots.length < match.actions.length + 1) {
      const backfilled = this._backfillSnapshots(match);
      if (backfilled) this.store.save(match);
    }
    if (match.rulesVersion !== game.rulesVersion
      && (!Array.isArray(match.snapshots) || match.snapshots.length < match.actions.length + 1)) {
      throw new ArenaError(
        'replay_version_mismatch',
        `这局由规则 ${match.rulesVersion} 生成，当前插件是 ${game.rulesVersion}，且没有可用的权威快照。`,
        { status: 409 },
      );
    }
    const snapshots = match.snapshots;
    if (!Array.isArray(snapshots) || snapshots.length < match.actions.length + 1) {
      throw new ArenaError('replay_corrupt', '这局回放缺少完整快照，无法安全重建。', { status: 500 });
    }
    const maxSteps = limit == null ? match.actions.length : Math.max(0, Math.min(match.actions.length, Number(limit) || 0));
    const initial = snapshots[0];
    const steps = [{
      index: 0,
      at: match.createdAt,
      seat: null,
      action: null,
      actionText: null,
      source: null,
      sourceName: null,
      metrics: null,
      view: initial?.view ?? null,
    }];
    for (let index = 1; index <= maxSteps; index += 1) {
      const entry = match.actions[index - 1];
      const snapshot = snapshots[index];
      if (!snapshot) break;
      steps.push({
        index,
        at: entry?.at ?? snapshot.at,
        seat: entry?.seat ?? null,
        action: entry?.action ?? null,
        actionText: entry?.action && game.describeAction ? game.describeAction(entry.action) : null,
        source: entry?.source ?? null,
        sourceName: entry?.sourceName ?? null,
        metrics: entry?.metrics ?? null,
        view: snapshot.view,
      });
    }
    const publicMatch = this.publicMatch(match);
    return {
      matchId: match.id,
      gameId: match.gameId,
      gameName: match.gameName,
      rulesVersion: match.rulesVersion,
      match: publicMatch,
      game: publicMatch.game,
      seats: match.seats,
      seatOrder: this._seatList(match).map((seat) => seat.id),
      authoritative: true,
      initialView: initial?.view ?? null,
      seed: match.seed ?? null,
      randomEvents: Array.isArray(match.randomEvents) ? match.randomEvents.slice() : [],
      steps,
      // 与网页既有语义一致：totalSteps 是最后一手的索引，steps[0] 是初始局面。
      totalSteps: Math.max(0, steps.length - 1),
      chat: filterVisible(match.chat, { role: 'observer', seat: null }),
      errors: match.errors.map((error) => ({
        at: error.at,
        code: error.code,
        message: error.message,
        seat: error.seat,
        source: error.source,
      })),
      result: match.result,
      resultGroup: resultGroup(match.result),
      resultLabel: match.resultLabel,
      outcome: match.outcome,
      winnerSeat: match.winnerSeat ?? null,
      winnerName: match.winnerName ?? null,
      modeLabel: match.modeLabel,
      configSnapshot: match.configSnapshot,
      actionCount: match.actions.length,
      replayVersion: 2,
    };
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
      const match = this.matches.get(id);
      this._clearSchedule(id);
      this._clearHealth(id);
      if (runtime.dafeiyuReleaseTimer) clearTimeout(runtime.dafeiyuReleaseTimer);
      if (runtime.pending?.controller) runtime.pending.controller.abort();
      if (runtime.autoAbort) runtime.autoAbort.abort();
      if (match) this._cancelDafeiyuSpeech(match);
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
