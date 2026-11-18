"""大肥鱼 → AI 桌游竞技场的可选 HTTP 桥。

这是对大肥鱼原有聊天、QQ、提醒、屏幕与酒馆功能的新增接口，默认只允许本机
Loopback Origin。竞技场负责棋盘与回合；本模块不直接执行任何落子。
"""

import asyncio
import hmac
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from . import settings
from .games.arena import ArenaError, build_service
from . import inference

LOCAL_HOSTS = ('127.0.0.1', '::1', 'localhost', 'testclient')
LOOPBACK_NAMES = ('127.0.0.1', '::1', 'localhost')


def enabled():
    return str(settings.get('arena_enabled', True)).lower() not in ('false', '0', 'no', 'off')


def _configured_origins():
    raw = settings.get('arena_origins', '')
    if isinstance(raw, str):
        return [item.strip().rstrip('/') for item in raw.split(',') if item.strip()]
    if isinstance(raw, (list, tuple)):
        return [str(item).strip().rstrip('/') for item in raw if str(item).strip()]
    return []


def _origin_allowed(origin):
    if not origin:
        return False
    configured = _configured_origins()
    normalized = origin.rstrip('/')
    if configured:
        return normalized in configured
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    if parsed.scheme not in ('http', 'https'):
        return False
    return parsed.hostname in LOOPBACK_NAMES


def _token_ok(request):
    token = str(settings.get('arena_token', '') or '')
    if not token:
        return True
    supplied = request.headers.get('x-arena-token', '')
    return hmac.compare_digest(str(supplied), token)


def build_router(handler, service=None):
    router = APIRouter(prefix='/api/game/arena')
    if not enabled():
        return router
    game = service or build_service(handler)

    def credentials(request: Request):
        client_host = request.client.host if request.client else ''
        if client_host not in LOCAL_HOSTS:
            raise ArenaError(403, '只允许本机桌宠访问竞技场桥。')
        origin = request.headers.get('origin', '').rstrip('/')
        if not _origin_allowed(origin):
            raise ArenaError(403, '竞技场 Origin 未被桌宠允许。请在桌宠 bridge/config.json 配置 arena_origins。')
        if not _token_ok(request):
            raise ArenaError(401, '竞技场接入令牌不正确。')
        return origin

    def payload_dict(request, payload):
        return payload if isinstance(payload, dict) else {}

    async def while_connected(request, operation):
        task = asyncio.create_task(operation)
        try:
            while not task.done():
                if await request.is_disconnected():
                    raise ArenaError(499, '请求已取消。', code='cancelled')
                await asyncio.wait({task}, timeout=0.2)
            return task.result()
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    @router.get('/model-monitor')
    async def model_monitor(request: Request):
        try:
            credentials(request)
            return {'ok': True, 'records': inference.snapshot()}
        except ArenaError as exc:
            return JSONResponse({'ok': False, 'error': {'code': 'forbidden', 'message': exc.message}}, status_code=exc.status)

    @router.post('/{operation}')
    async def dispatch(operation: str, request: Request, payload: dict):
        try:
            origin = credentials(request)
            body = payload_dict(request, payload)
            if operation == 'connect':
                result = game.connect(origin, body.get('matchId'))
            elif operation == 'status':
                result = game.status(body.get('sessionId'), origin, body.get('matchId'))
            elif operation == 'comment':
                result = await while_connected(request, game.comment(
                    body.get('sessionId'), origin, body.get('matchId'),
                    body.get('role'), body.get('seat'), body.get('snapshot'),
                    body.get('event'), body.get('mode', 'auto'),
                ))
            elif operation == 'question':
                result = await while_connected(request, game.question(
                    body.get('sessionId'), origin, body.get('matchId'),
                    body.get('role'), body.get('seat'), body.get('snapshot'),
                    body.get('question'),
                ))
            elif operation == 'move':
                result = await while_connected(request, game.move(
                    body.get('sessionId'), origin, body.get('matchId'),
                    body.get('seat'), body.get('snapshot'),
                    body.get('feedback', ''), body.get('requestId', ''),
                ))
            elif operation == 'speak':
                result = await game.speak(
                    body.get('sessionId'), origin, body.get('matchId'),
                    body.get('text'), body.get('key'),
                )
            elif operation == 'speak-cancel':
                result = game.cancel_speech(
                    body.get('sessionId'), origin, body.get('matchId'),
                )
            elif operation == 'leave':
                result = game.leave(body.get('sessionId'), origin, body.get('matchId'))
            else:
                raise ArenaError(404, '未知的竞技场桥操作。', code='not_found')
            return {'ok': True, **result}
        except ArenaError as exc:
            return JSONResponse(
                {'ok': False, 'error': {'code': exc.code or _error_code(exc.status), 'message': exc.message}},
                status_code=exc.status,
            )
        except Exception:
            # 不把内部堆栈、模型地址或任何密钥返回给竞技场。
            return JSONResponse(
                {'ok': False, 'error': {'code': 'arena_bridge_error', 'message': '桌宠竞技场桥内部错误。'}},
                status_code=500,
            )

    return router


def _error_code(status):
    return {
        400: 'bad_request',
        401: 'auth',
        403: 'forbidden',
        404: 'not_found',
        409: 'session_conflict',
        413: 'payload_too_large',
        429: 'busy',
        502: 'model_error',
        504: 'model_timeout',
    }.get(status, 'arena_bridge_error')
