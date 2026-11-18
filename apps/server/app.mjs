import { buildMatchTiming } from './match-timing.mjs';
import { ModelMonitor, legacyRequests } from './model-monitor.mjs';
import { ModelBenchmarks } from './model-benchmark.mjs';
import { REASONING_PROFILES, describeReasoning, reasoningAdapter } from '../../packages/models/reasoning.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.mjs';
import { MatchStore } from './match-store.mjs';
import { EventHub } from './event-hub.mjs';
import { MatchService } from './match-service.mjs';
import {
  sendJson,
  sendText,
  sendError,
  readJson,
  securityHeaders,
  isLoopbackHostname,
} from './http-utils.mjs';
import { listProviders, testModelConnection, validateModelConfig } from '../../packages/models/index.mjs';
import { GAME_PLUGINS } from '../../packages/games/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', 'web');
export const VERSION = '0.2.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function matchRoute(pathname, regex) {
  const match = regex.exec(pathname);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

const CONFIG_ERROR_STATUS = {
  invalid_model: 400,
  duplicate_model_name: 409,
  invalid_dafeiyu_url: 400,
  invalid_dafeiyu_path: 400,
  invalid_dafeiyu_timeout: 400,
};

function normalizeError(error) {
  if (error?.name === 'ArenaError') {
    return {
      status: error.status ?? 400,
      code: error.code ?? 'arena_error',
      message: error.message,
      details: error.details ?? null,
    };
  }
  if (error?.status && error?.code) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }
  if (error?.code && CONFIG_ERROR_STATUS[error.code]) {
    return {
      status: CONFIG_ERROR_STATUS[error.code],
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }
  return null;
}

export async function createArenaApp({
  configPath = process.env.ARENA_CONFIG,
  clientFactory = undefined,
  logger = console,
  autoStart = false,
  gamePlugins = GAME_PLUGINS,
} = {}) {
  const configStore = new ConfigStore({ configPath });
  const monitor = new ModelMonitor(path.join(path.dirname(configStore.configPath), 'model-monitor'));
  const hub = new EventHub({ heartbeatMs: configStore.matchSettings.sseHeartbeatMs });
  const store = new MatchStore(configStore.matchDir);
  let publicUrl = '';
  const matchService = new MatchService({
    configStore,
    monitor,
    store,
    hub,
    logger,
    clientFactory,
    gamePlugins,
    originProvider: () => publicUrl.replace(/\/$/, ''),
    version: VERSION,
  });
  const benchmarks = new ModelBenchmarks(matchService,monitor);
  let bridgeCache={at:0,records:[],online:false};
  async function bridgeRecords(){
    if(Date.now()-bridgeCache.at<1500)return bridgeCache;
    const cfg=configStore.dafeiyuSettings();
    try{
      const response=await fetch(cfg.bridgeUrl+cfg.apiBase+'/model-monitor',{headers:{Origin:publicUrl.replace(/\/$/,''),'X-Arena-Token':cfg.token??''},signal:AbortSignal.timeout(1200)});
      const body=await response.json();
      bridgeCache={at:Date.now(),records:Array.isArray(body.records)?body.records.map(row=>{
        const match=matchService.matches.get(row.matchId);
        const action=match?.actions.find(a=>a.requestId===row.correlationId);
        return {...row,gameId:row.gameId??match?.gameId,step:row.step??action?.index};
      }):[],online:response.ok};
    }catch{bridgeCache={at:Date.now(),records:[],online:false};}
    return bridgeCache;
  }
  const startedAt = new Date().toISOString();

  function bootstrap() {
    return {
      app: {
        name: 'AI Arena',
        version: VERSION,
        url: publicUrl,
        startedAt,
      },
      games: matchService.games,
      providers: listProviders(),
      reasoningProfiles: REASONING_PROFILES,
      models: configStore.listModels(),
      dafeiyu: configStore.publicDafeiyuSettings(),
      builtInBot: {
        name: '内置机器人',
        available: true,
        description: '本机启发式落子，不需要 API Key，用来快速试玩完整流程。',
      },
      matchSettings: {
        aiMoveDelayMs: configStore.matchSettings.aiMoveDelayMs,
        autoCommentCooldownMs: configStore.matchSettings.autoCommentCooldownMs,
      },
    };
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return null;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return '请求来源格式不正确。';
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      return '只接受本机网页来源。';
    }
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (parsed.host.toLowerCase() !== hostHeader) {
      return '请求来源与当前服务地址不一致。';
    }
    return null;
  }

  function serveStatic(req, res, pathname) {
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative === 'favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    let filePath;
    try {
      filePath = path.resolve(WEB_ROOT, decodeURIComponent(relative));
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }
    if (!filePath.startsWith(WEB_ROOT + path.sep) && filePath !== WEB_ROOT) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const headers = {
      ...securityHeaders(),
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
    };
    if (relative === 'index.html') {
      headers['Cache-Control'] = 'no-store';
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const data = fs.readFileSync(filePath);
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/api/desktop-companion' && ['GET', 'POST'].includes(method)) {
      if (req.headers['x-arena-desktop'] !== '1') {
        sendError(res, 403, 'desktop_only', '此接口供本机桌宠客户端使用。');
        return;
      }
      const state = matchService.desktopCompanion();
      if (method === 'POST') {
        const body = await readJson(req);
        if (!state.active || state.matchId !== body.matchId) {
          sendError(res, 409, 'old_match', '当前对局已经变化。');
          return;
        }
        if (body.type === 'question') await matchService.askDafeiyu(state.matchId, { text: body.text });
        else if (body.type === 'auto' && typeof body.value === 'boolean') await matchService.patchDafeiyu(state.matchId, { autoComment: body.value });
        else if (body.type === 'voice' && typeof body.value === 'boolean') await matchService.patchDafeiyu(state.matchId, { voice: body.value });
        else { sendError(res, 400, 'invalid_desktop_command', '无效的桌宠操作。'); return; }
      }
      sendJson(res, 200, { state: matchService.desktopCompanion() }, { 'Cache-Control': 'no-store' });
      return;
    }

    if(method==='POST' && pathname==='/api/models/reasoning-preview'){
      const body=await readJson(req); const adapter=reasoningAdapter(body);
      if(!REASONING_PROFILES[adapter])throw Object.assign(new Error('未知的推理协议'),{status:400,code:'invalid_reasoning'});
      sendJson(res,200,{reasoning:describeReasoning(body),profile:REASONING_PROFILES[adapter]});return;
    }
    if(method==='GET' && pathname==='/api/monitor/export'){
      const bridge=await bridgeRecords();
      const filters=Object.fromEntries(['matchId','modelId','gameId','effort','task','pace','moveMode','origin','benchmarkId'].map(k=>[k,url.searchParams.get(k)||'']));
      const report=monitor.snapshot({historical:legacyRequests(matchService.matches.values()),external:bridge.records,filters,limit:20000});
      sendJson(res,200,report,{'Content-Disposition':'attachment; filename="model-monitor.json"','Cache-Control':'no-store'});return;
    }
    const matchTimingRoute=method==='GET' && matchRoute(pathname,/^\/api\/monitor\/matches\/([^/]+)$/);
    if(matchTimingRoute){
      const match=matchService.getMatch(matchTimingRoute[0]);
      const bridge=await bridgeRecords();
      const report=monitor.snapshot({historical:legacyRequests(matchService.matches.values()),external:bridge.records,filters:{matchId:match.id},limit:20000});
      sendJson(res,200,buildMatchTiming(match,report.recent,report.active),{'Cache-Control':'no-store'});return;
    }
    if(method==='GET' && pathname==='/api/monitor'){
      const bridge=await bridgeRecords();
      const filters=Object.fromEntries(['matchId','modelId','gameId','effort','task','pace','moveMode','origin','benchmarkId'].map(k=>[k,url.searchParams.get(k)||'']));
      sendJson(res,200,{...monitor.snapshot({historical:legacyRequests(matchService.matches.values()),external:bridge.records,filters}),
        bridgeOnline:bridge.online,benchmarks:benchmarks.list(),matches:matchService.listMatches()},{'Cache-Control':'no-store'});return;
    }
    if(method==='POST' && pathname==='/api/monitor/benchmarks'){
      sendJson(res,202,{benchmark:benchmarks.start(await readJson(req))});return;
    }
    const benchmarkCancel=method==='POST' && matchRoute(pathname,/^\/api\/monitor\/benchmarks\/([a-f0-9-]+)\/cancel$/);
    if(benchmarkCancel){sendJson(res,200,{ok:benchmarks.cancel(benchmarkCancel[0])});return;}
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'ai-arena',
        version: VERSION,
        time: new Date().toISOString(),
      });
      return;
    }
    if (method === 'GET' && pathname === '/api/bootstrap') {
      sendJson(res, 200, bootstrap());
      return;
    }
    if (method === 'GET' && pathname === '/api/games') {
      sendJson(res, 200, { games: matchService.games });
      return;
    }
    if (method === 'GET' && pathname === '/api/providers') {
      sendJson(res, 200, { providers: listProviders() });
      return;
    }
    if (method === 'GET' && pathname === '/api/models') {
      sendJson(res, 200, { models: configStore.listModels() });
      return;
    }
    if (method === 'POST' && pathname === '/api/models') {
      const body = await readJson(req);
      const model = configStore.addModel(body);
      sendJson(res, 201, { model });
      return;
    }
    if (method === 'POST' && pathname === '/api/models/test') {
      const body = await readJson(req);
      let base = body;
      if (body.id) {
        const saved = configStore.modelConfig(String(body.id));
        if (!saved) {
          throw Object.assign(new Error('模型配置不存在。'), { status: 404, code: 'model_not_found' });
        }
        base = {
          ...saved,
          ...body,
          name: body.name ?? saved.name,
          apiKey: Object.prototype.hasOwnProperty.call(body, 'apiKey') ? body.apiKey : saved.apiKey,
        };
      }
      const validation = validateModelConfig({ ...base, name: base.name || '连接测试' });
      if (!validation.ok) {
        sendJson(res, 200, {
          ok: false,
          durationMs: 0,
          error: {
            code: 'config',
            label: '配置错误',
            message: validation.errors.join(' '),
            stage: 'config',
            details: validation.errors,
          },
          checks: [
            { name: '配置', ok: false, detail: validation.errors.join(' ') },
            { name: '地址', ok: null, detail: '配置未通过，未发起请求。' },
            { name: '认证与模型', ok: null, detail: '配置未通过，未发起请求。' },
          ],
        });
        return;
      }
      const result = await testModelConnection(validation.value);
      sendJson(res, 200, result);
      return;
    }
    const modelTest = method === 'POST' && matchRoute(pathname, /^\/api\/models\/([^/]+)\/test$/);
    if (modelTest) {
      const [id] = modelTest;
      const saved = configStore.modelConfig(id);
      if (!saved) throw Object.assign(new Error('模型配置不存在。'), { status: 404, code: 'model_not_found' });
      const result = await testModelConnection(saved);
      sendJson(res, 200, result);
      return;
    }
    const modelRoute = matchRoute(pathname, /^\/api\/models\/([^/]+)$/);
    if (modelRoute && method === 'PUT') {
      const [id] = modelRoute;
      const body = await readJson(req);
      const model = configStore.updateModel(id, body);
      if (!model) throw Object.assign(new Error('模型配置不存在。'), { status: 404, code: 'model_not_found' });
      sendJson(res, 200, { model });
      return;
    }
    if (modelRoute && method === 'DELETE') {
      const [id] = modelRoute;
      const removed = configStore.removeModel(id);
      if (!removed) throw Object.assign(new Error('模型配置不存在。'), { status: 404, code: 'model_not_found' });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && pathname === '/api/games') {
      sendJson(res, 200, { games: matchService.games });
      return;
    }
    if (method === 'GET' && pathname === '/api/dafeiyu/config') {
      sendJson(res, 200, { dafeiyu: configStore.publicDafeiyuSettings() });
      return;
    }
    if (method === 'PUT' && pathname === '/api/dafeiyu/config') {
      const body = await readJson(req);
      const dafeiyu = configStore.updateDafeiyu(body);
      sendJson(res, 200, { dafeiyu });
      return;
    }
    if (method === 'GET' && pathname === '/api/dafeiyu/health') {
      const health = await matchService.pingDafeiyu();
      sendJson(res, 200, health);
      return;
    }
    if (method === 'GET' && pathname === '/api/matches') {
      const filters = {
        player: url.searchParams.get('player') ?? '',
        result: url.searchParams.get('result') ?? '',
        status: url.searchParams.get('status') ?? '',
        game: url.searchParams.get('game') ?? '',
        q: url.searchParams.get('q') ?? '',
      };
      sendJson(res, 200, {
        matches: matchService.listMatches(filters),
        filters,
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/matches') {
      const body = await readJson(req);
      const match = await matchService.createMatch(body);
      sendJson(res, 201, { match });
      return;
    }

    const sse = method === 'GET' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/events$/);
    if (sse) {
      const [id] = sse;
      const snapshot = matchService.getMatch(id);
      res.writeHead(200, {
        ...securityHeaders(),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      res.write(`event: match\ndata: ${JSON.stringify(snapshot)}\n\n`);
      const unsubscribe = hub.subscribe(id, res);
      matchService.cancelViewerRelease(id);
      res.once('close', () => {
        unsubscribe();
        matchService.scheduleViewerRelease(id);
      });
      return;
    }
    const privateView = method === 'GET' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/human-view$/);
    if (privateView) {
      if (req.headers['x-arena-human-view'] !== '1') {
        sendError(res, 403, 'private_view', '需要本机牌桌才能查看真人席位。');
        return;
      }
      sendJson(res, 200, { view: matchService.humanView(privateView[0]) }, { 'Cache-Control': 'no-store' });
      return;
    }
    const replay = method === 'GET' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/replay$/);
    if (replay) {
      const [id] = replay;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam == null ? null : Number(limitParam);
      if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
        sendError(res, 400, 'invalid_limit', 'limit 必须是非负整数。');
        return;
      }
      sendJson(res, 200, matchService.getReplay(id, { limit }));
      return;
    }
    const exportRoute = method === 'GET' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/export$/);
    if (exportRoute) {
      const [id] = exportRoute;
      const data = matchService.exportMatch(id);
      const body = `${JSON.stringify(data, null, 2)}\n`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="arena-${id}.json"`,
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return;
    }
    const actionRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/actions$/);
    if (actionRoute) {
      const [id] = actionRoute;
      const body = await readJson(req);
      const result = await matchService.submitHumanAction(id, body);
      sendJson(res, 200, result);
      return;
    }
    const pauseRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/pause$/);
    if (pauseRoute) {
      const [id] = pauseRoute;
      const match = matchService.pauseMatch(id);
      sendJson(res, 200, { match });
      return;
    }
    const pauseAfterRoute=method==='POST' && matchRoute(pathname,/^\/api\/matches\/([^/]+)\/pause-after-move$/);
    if(pauseAfterRoute){sendJson(res,200,{match:matchService.pauseAfterMove(pauseAfterRoute[0])});return;}
    const resumeRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/resume$/);
    if (resumeRoute) {
      const [id] = resumeRoute;
      const match = matchService.resumeMatch(id);
      sendJson(res, 200, { match });
      return;
    }
    const stepRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/step$/);
    if (stepRoute) {
      const [id] = stepRoute;
      const match = await matchService.stepMatch(id);
      sendJson(res, 200, { match });
      return;
    }
    const retryRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/retry$/);
    if (retryRoute) {
      const [id] = retryRoute;
      const match = matchService.retryMatch(id);
      sendJson(res, 200, { match });
      return;
    }
    const endRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/end$/);
    if (endRoute) {
      const [id] = endRoute;
      const body = await readJson(req);
      const match = matchService.endMatch(id, { reason: body.reason });
      sendJson(res, 200, { match });
      return;
    }
    const chatRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/chat$/);
    if (chatRoute) {
      const [id] = chatRoute;
      const body = await readJson(req);
      const match = await matchService.askDafeiyu(id, { text: body.text, voice: body.voice, analysis:body.analysis === true });
      sendJson(res, 200, { match });
      return;
    }
    const dafeiyuConfigRoute = method === 'PATCH' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/dafeiyu$/);
    if (dafeiyuConfigRoute) {
      const [id] = dafeiyuConfigRoute;
      const body = await readJson(req);
      const match = await matchService.patchDafeiyu(id, body);
      sendJson(res, 200, { match });
      return;
    }
    const reconnectRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/dafeiyu\/reconnect$/);
    if (reconnectRoute) {
      const [id] = reconnectRoute;
      const match = await matchService.reconnectDafeiyu(id);
      sendJson(res, 200, { match });
      return;
    }
    const disconnectRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/dafeiyu\/disconnect$/);
    if (disconnectRoute) {
      const [id] = disconnectRoute;
      const match = await matchService.disconnectDafeiyu(id);
      sendJson(res, 200, { match });
      return;
    }
    const leaveRoute = method === 'POST' && matchRoute(pathname, /^\/api\/matches\/([^/]+)\/leave$/);
    if (leaveRoute) {
      const [id] = leaveRoute;
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const match = await matchService.leaveMatch(id, { reason: body.reason });
      sendJson(res, 200, { match });
      return;
    }
    const matchGet = method === 'GET' && matchRoute(pathname, /^\/api\/matches\/([^/]+)$/);
    if (matchGet) {
      const [id] = matchGet;
      sendJson(res, 200, { match: matchService.getMatch(id) });
      return;
    }

    sendError(res, 404, 'not_found', 'API 路径不存在。');
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    res.setHeader('X-Arena-Version', VERSION);
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const originError = checkOrigin(req);
      if (originError) {
        sendError(res, 403, 'origin_rejected', originError);
        return;
      }
      try {
        await handleApi(req, res, url);
      } catch (error) {
        if (res.headersSent) {
          try {
            res.end();
          } catch {
            // 连接已关闭。
          }
          return;
        }
        const normalized = normalizeError(error);
        if (normalized) {
          sendError(
            res,
            normalized.status,
            normalized.code,
            normalized.message,
            normalized.details,
          );
        } else {
          logger.error?.(`API 错误：${error?.stack ?? error}`);
          sendError(res, 500, 'internal_error', '竞技场内部错误，请查看启动窗口日志。');
        }
      } finally {
        const ms = Date.now() - started;
        logger.info?.(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
      }
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        serveStatic(req, res, url.pathname);
      } catch (error) {
        logger.error?.(`静态文件错误：${error?.message ?? error}`);
        if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      }
      return;
    }
    sendText(res, 405, 'Method Not Allowed');
  });

  const app = {
    configStore,
    store,
    hub,
    matchService,
    monitor,
    benchmarks,
    get publicUrl() {
      return publicUrl;
    },
    server,
    async start({ port = configStore.server.port, host = configStore.server.host } = {}) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const displayHost = isLoopbackHostname(host) ? host : '127.0.0.1';
      publicUrl = `http://${displayHost}:${actualPort}`;
      hub.start();
      logger.info?.(`AI Arena 已启动：${publicUrl}`);
      return { url: publicUrl, port: actualPort, host };
    },
    async close() {
      await benchmarks.close();
      const closingMatches = matchService.close();
      hub.close();
      await closingMatches;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
  if (autoStart) await app.start();
  return app;
}
