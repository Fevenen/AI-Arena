"""Per-request thinking policy, private telemetry and a cross-process local GPU queue.

No prompts, answers, images, credentials or reasoning text are written to telemetry.
The queue protocol is shared with Arena's optional local model client.
"""
import asyncio
import ctypes
import hashlib
import json
import os
import tempfile
import threading
import time
import uuid
import httpx
from pathlib import Path
from urllib.parse import urlsplit

from . import settings

_guard = threading.Lock()
_active = {}


def policy(body, thinking='off', adapter='qwen', effort='default'):
    result = dict(body)
    kwargs = dict(result.get('chat_template_kwargs') or {})
    # Desktop tasks have an explicit task policy; never toggle shared server settings.
    result.pop('reasoning_effort', None)
    kwargs.pop('reasoning_effort', None)
    if thinking in ('on', 'off'):
        kwargs['enable_thinking'] = thinking == 'on'
    if kwargs:
        result['chat_template_kwargs'] = kwargs
    if adapter == 'kvmem' and thinking != 'off' and effort in ('low', 'medium', 'high'):
        result['reasoning_effort'] = effort
    return result


def _alive(pid):
    if os.name == 'nt':
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return kernel.GetLastError() == 5
        code = ctypes.c_ulong()
        try:
            return not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _write_active():
    root = settings.DATA_DIR / 'model-monitor'
    root.mkdir(parents=True, exist_ok=True)
    target = root / f'active-{os.getpid()}.json'
    temporary = root / f'active-{os.getpid()}.tmp'
    temporary.write_text(json.dumps(list(_active.values()), ensure_ascii=False), encoding='utf-8')
    temporary.replace(target)


class Job:
    def __init__(self, body, endpoint, task='chat', context=None):
        self.started = time.monotonic()
        self._last_write = 0
        self.id = str(uuid.uuid4())
        self.lock = self.ticket = self.slot = None
        kwargs = body.get('chat_template_kwargs') or {}
        off = kwargs.get('enable_thinking') is False
        on = kwargs.get('enable_thinking') is True
        effort = body.get('reasoning_effort')
        self.row = dict(id=self.id, origin='dafeiyu', modelId=body.get('model'), modelName='大肥鱼',
                        task=task, startedAt=time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + f'.{int(time.time()*1000)%1000:03d}Z',
                        pid=os.getpid(), status='running', stage='queued', maxTokens=body.get('max_tokens'),
                        reasoning=dict(adapter='kvmem' if effort else 'qwen', source='engine' if effort else 'model',
                                       thinking='off' if off else 'on' if on else 'default', effort=effort or 'default',
                                       label='关闭思考' if off else f'引擎 {effort}' if effort else '开启思考' if on else '跟随服务默认',
                                       sent={key: body[key] for key in ('reasoning_effort', 'chat_template_kwargs') if key in body},
                                       confirmation='requested' if off or on or effort else 'inherited'))
        for key in ('matchId', 'gameId', 'step', 'seat', 'pace', 'moveMode', 'correlationId'):
            if context and key in context:
                self.row[key] = context[key]
        url = urlsplit(endpoint)
        if url.hostname in ('127.0.0.1', 'localhost', '::1'):
            port = str(url.port or '')
            key = hashlib.sha256(('loopback:' + port).encode()).hexdigest()[:24]
            self.slot = Path(tempfile.gettempdir()) / 'dafeiyu-inference-v1' / key
            self.slot.mkdir(parents=True, exist_ok=True)
            self.ticket = self.slot / (self.id + '.json')
            priority = 0 if task == 'timed_move' else 1 if task in ('chat', 'question', 'intent') else 2 if task == 'move' else 5
            self.owner = dict(id=self.id, pid=os.getpid(), priority=priority, created=int(time.time()*1000))
            self.ticket.write_text(json.dumps(self.owner), encoding='utf-8')
        self.progress('queued')

    def progress(self, stage, **values):
        previous = self.row.get('stage')
        self.row.update(values, stage=stage, elapsedMs=round((time.monotonic()-self.started)*1000))
        with _guard:
            _active[self.id] = self.row.copy()
            if previous != stage or time.monotonic()-self._last_write > .3:
                _write_active()
                self._last_write = time.monotonic()

    def try_acquire(self):
        if self.slot is None:
            self.progress('requesting', queueMs=0)
            return True
        waiting = []
        for file in self.slot.glob('*.json'):
            try:
                row = json.loads(file.read_text(encoding='utf-8'))
                if _alive(row['pid']):
                    waiting.append(row)
                else:
                    file.unlink(missing_ok=True)
            except (OSError, ValueError, KeyError):
                pass
        waiting.sort(key=lambda r: (r['priority'], r['created'], r['id']))
        if not waiting or waiting[0]['id'] != self.id:
            return False
        lock = self.slot / 'slot'
        try:
            lock.mkdir()
            (lock / 'owner.json').write_text(json.dumps(self.owner), encoding='utf-8')
        except FileExistsError:
            try:
                owner = json.loads((lock / 'owner.json').read_text(encoding='utf-8'))
                if not _alive(owner['pid']):
                    (lock / 'owner.json').unlink()
                    lock.rmdir()
            except (OSError, ValueError, KeyError):
                try:
                    if time.time()-lock.stat().st_mtime > 5:
                        lock.rmdir()  # Only removes an empty, abandoned creation.
                except OSError:
                    pass
            return False
        self.lock = lock
        self.ticket.unlink(missing_ok=True)
        self.progress('requesting', queueMs=round((time.monotonic()-self.started)*1000))
        return True

    async def acquire(self, timeout=120, background=False):
        deadline = time.monotonic() + timeout
        while not self.try_acquire():
            if background:
                raise RuntimeError('background_skipped')
            if time.monotonic() >= deadline:
                raise TimeoutError('local_queue_timeout')
            await asyncio.sleep(.06)

    def acquire_sync(self, timeout=120):
        deadline = time.monotonic() + timeout
        while not self.try_acquire():
            if time.monotonic() >= deadline:
                raise TimeoutError('local_queue_timeout')
            time.sleep(.06)

    def usage(self, payload):
        usage = payload.get('usage') or {}
        if usage:
            self.row['usage'] = {key: usage.get(key) for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')}
            self.row['usage']['completion_tokens_details'] = dict(reasoning_tokens=(usage.get('completion_tokens_details') or {}).get('reasoning_tokens'))
        choice = (payload.get('choices') or [{}])[0]
        self.row['finishReason'] = choice.get('finish_reason') or self.row.get('finishReason')
        delta = choice.get('delta') or {}
        if delta.get('reasoning_content'):
            self.row.setdefault('firstOutputMs', round((time.monotonic()-self.started)*1000))
            self.progress('thinking')
        if delta.get('content'):
            elapsed = round((time.monotonic()-self.started)*1000)
            self.row.setdefault('firstOutputMs', elapsed)
            self.row.setdefault('firstAnswerMs', elapsed)
            self.progress('answering')

    def finish(self, status='completed', error=None):
        if self.row.get('status') != 'running':
            return
        if self.ticket:
            self.ticket.unlink(missing_ok=True)
        if self.lock:
            try:
                owner = json.loads((self.lock / 'owner.json').read_text(encoding='utf-8'))
                if owner['id'] == self.id:
                    (self.lock / 'owner.json').unlink()
                    self.lock.rmdir()
            except (OSError, ValueError):
                pass
        if status == 'completed' and self.row.get('finishReason') == 'length':
            status = 'truncated'
        self.row.update(status=status, stage=status, elapsedMs=round((time.monotonic()-self.started)*1000))
        if error:
            self.row['errorCode'] = error
        with _guard:
            _active.pop(self.id, None)
            root = settings.DATA_DIR / 'model-monitor'
            root.mkdir(parents=True, exist_ok=True)
            with (root / f'requests-{os.getpid()}.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(self.row, ensure_ascii=False) + '\n')
            _write_active()


def snapshot():
    rows = []
    root = settings.DATA_DIR / 'model-monitor'
    for file in root.glob('active-*.json'):
        try:
            pid = int(file.stem.split('-')[-1])
            if _alive(pid):
                rows.extend(json.loads(file.read_text(encoding='utf-8')))
        except (OSError, ValueError):
            pass
    for file in root.glob('requests-*.jsonl'):
        try:
            with file.open('rb') as stream:
                stream.seek(0, 2)
                size = stream.tell()
                stream.seek(max(0, size-2_000_000))
                data = stream.read().decode('utf-8', errors='ignore').splitlines()
            for line in data[-2000:]:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
        except OSError:
            pass
    return rows


class GeneratedText(str):
    """Keeps the existing string generator interface while returning safe request metadata."""
    def __new__(cls, text, metadata):
        value = super().__new__(cls, text)
        value.monitor_meta = metadata
        return value


async def complete(body, endpoint, task='chat', context=None, timeout=120):
    measure_stream = task in ('move', 'timed_move') or (body.get('chat_template_kwargs') or {}).get('enable_thinking') is True
    body = {**body, 'stream': measure_stream}
    if measure_stream:
        body['stream_options'] = {'include_usage': True}
    job = Job(body, endpoint, task, context)
    async def read_response(client):
        content, finish, usage = '', None, None
        if not measure_stream:
            job.progress('waiting_output')
            response = await client.post(endpoint, json=body, headers={'Authorization':'Bearer local'})
            response.raise_for_status()
            parsed = response.json()
            job.usage(parsed)
            return parsed
        async with client.stream('POST', endpoint, json=body, headers={'Authorization':'Bearer local'}) as response:
            job.progress('waiting_output', headersMs=round((time.monotonic()-job.started)*1000))
            response.raise_for_status()
            if 'text/event-stream' not in response.headers.get('content-type', ''):
                await response.aread()
                parsed = response.json()
                job.usage(parsed)
                return parsed
            async for line in response.aiter_lines():
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if data == '[DONE]':
                    continue
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                job.usage(chunk)
                choice = (chunk.get('choices') or [{}])[0]
                delta = choice.get('delta') or {}
                if isinstance(delta.get('content'), str):
                    content += delta['content']
                finish = choice.get('finish_reason') or finish
                usage = chunk.get('usage') or usage
        return {'choices':[{'message':{'content':content}, 'finish_reason':finish}], 'usage':usage}
    try:
        try:
            await job.acquire(timeout=timeout, background=task in ('comment', 'screen_comment', 'tavern_comment'))
        except TimeoutError as exc:
            raise httpx.ReadTimeout('local_queue_timeout') from exc
        remaining = max(.01, timeout-(time.monotonic()-job.started))
        async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(remaining, connect=min(5, remaining))) as client:
            parsed = await asyncio.wait_for(read_response(client), timeout=remaining)
        job.finish()
        parsed['_monitor'] = job.row
        return parsed
    except BaseException as exc:
        status = 'cancelled' if isinstance(exc, asyncio.CancelledError) else 'skipped' if str(exc)=='background_skipped' else 'failed'
        code = 'timeout' if isinstance(exc, (TimeoutError, httpx.TimeoutException)) else 'background_skipped' if status=='skipped' else type(exc).__name__
        job.finish(status, code)
        if isinstance(exc, TimeoutError):
            raise httpx.ReadTimeout('model_timeout') from exc
        raise
