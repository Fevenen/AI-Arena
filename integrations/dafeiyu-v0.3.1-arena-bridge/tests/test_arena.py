"""大肥鱼竞技场桥接的离线回归：不访问真实模型、不播音、不读取桌面数据。"""

import asyncio
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from bridge import settings
from bridge.arena_routes import build_router
from bridge.games.arena import ArenaError, ArenaService, _clean_text, _model_url
from bridge.presentation import cancel_jobs

ORIGIN = 'http://127.0.0.1:8787'
MATCH = 'match-test-1'


class FakeModel:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def __call__(self, prompt, data, max_tokens=None):
        self.calls.append({'prompt': prompt, 'data': data, 'max_tokens': max_tokens})
        if not self.responses:
            raise AssertionError('unexpected model call')
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class FakeSpeak:
    def __init__(self, status='queued'):
        self.status = status
        self.calls = []

    async def __call__(self, text, key, valid=None):
        self.calls.append({'text': text, 'key': key, 'valid': valid})
        return self.status


class FakeCancelVoice:
    def __init__(self):
        self.calls = []

    def __call__(self, prefix):
        self.calls.append(prefix)
        return 1


def snapshot(*, seat_label='黑方', outcome=None, assisted=None):
    value = {
        'protocolVersion': 1,
        'game': {'id': 'gomoku', 'name': '自由五子棋', 'rulesText': '15x15, 五连获胜',
                 'coordinateSystem': {'columns': 'A-O', 'rows': '15-1'},
                 'actionFormat': '{"move":"H8"}'},
        'seats': [
            {'id': 'black', 'name': '黑方'},
            {'id': 'white', 'name': '白方'},
        ],
        'seatLabel': seat_label,
        'state': {'board': [[None] * 15 for _ in range(15)], 'turn': 'black'},
        'recentActions': [],
        'outcome': outcome,
    }
    if assisted:
        value['assisted'] = assisted
    return value


class ArenaServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = [1000.0]
        self.model = FakeModel([])
        self.speak = FakeSpeak()
        self.cancel_voice = FakeCancelVoice()
        self.service = ArenaService(
            model=self.model,
            speak=self.speak,
            cancel_voice=self.cancel_voice,
            persona=lambda: '你是大肥鱼，聪明、嘴硬心软。',
            clock=lambda: self.now[0],
        )
        self.connected = self.service.connect(ORIGIN, MATCH)
        self.session = self.connected['sessionId']

    async def test_connect_status_origin_and_match_binding(self):
        self.assertEqual(self.connected['personaName'], '大肥鱼')
        self.assertIn('move', self.connected['capabilities'])
        self.assertIn('speak-cancel', self.connected['capabilities'])
        self.assertTrue(self.service.status(self.session, ORIGIN, MATCH)['connected'])
        with self.assertRaises(ArenaError) as wrong_origin:
            self.service.status(self.session, 'http://evil.example', MATCH)
        self.assertEqual(wrong_origin.exception.status, 403)
        with self.assertRaises(ArenaError) as wrong_match:
            self.service.status(self.session, ORIGIN, 'another-match')
        self.assertEqual(wrong_match.exception.status, 409)
        self.service.leave(self.session, ORIGIN, MATCH)
        with self.assertRaises(ArenaError):
            self.service.status(self.session, ORIGIN, MATCH)

    async def test_comment_uses_current_persona_and_event(self):
        self.model.responses = ['```\n这一手右边有威胁，别装没看见。\n```']
        result = await self.service.comment(
            self.session, ORIGIN, MATCH, 'observer', None, snapshot(),
            {'key': 'threat:black:H8', 'type': 'threat', 'summary': '黑方 H8 可成五'},
        )
        self.assertEqual(result['text'], '这一手右边有威胁，别装没看见。')
        call = self.model.calls[0]
        self.assertIn('大肥鱼', call['prompt'])
        self.assertIn('只针对本次关键事件', call['prompt'])
        self.assertIn('观战者', call['prompt'])
        self.assertEqual(call['data']['event']['key'], 'threat:black:H8')
        self.assertEqual(call['max_tokens'], 220)
        self.assertEqual(result['personaName'], '大肥鱼')
        self.assertFalse(self.speak.calls)

    async def test_comment_and_question_use_player_identity_and_outcome(self):
        self.model.responses = ['（盯着自己的白棋）我漏了那条斜线，这手只能先堵一个。', '我这局输了，但下一手还是会走。']
        result = await self.service.comment(
            self.session, ORIGIN, MATCH, 'player', 'white',
            snapshot(seat_label='白方', outcome={
                'type': 'win', 'winnerSeat': 'black', 'winnerLabel': '黑方',
            }),
            {'key': 'end:win:black:8', 'type': 'game_end', 'summary': '黑方以 F10 落子获胜。'},
        )
        self.assertIn('白棋', result['text'])
        prompt = self.model.calls[0]['prompt']
        self.assertIn('本局棋手', prompt)
        self.assertIn('白方', prompt)
        self.assertIn('你输了', prompt)
        self.assertIn('黑方获胜', prompt)
        self.assertIn('自己的颜色', prompt)
        answer = await self.service.question(
            self.session, ORIGIN, MATCH, 'player', 'white',
            snapshot(seat_label='白方', outcome={'type': 'win', 'winnerSeat': 'black'}),
            '你现在还能做什么？',
        )
        self.assertIn('输了', answer['text'])
        self.assertIn('白方', self.model.calls[1]['prompt'])

    async def test_question_and_move_are_independent_of_speech_and_include_modes(self):
        self.model.responses = [
            '黑棋右边有一条潜在连线，先堵住要命的空点。',
            '{"move":"H8","say":"我先占中间。"}',
            '{"cell":5,"say":"辅助模式。"}',
        ]
        answer = await self.service.question(
            self.session, ORIGIN, MATCH, 'observer', None, snapshot(), '黑棋现在有什么威胁？'
        )
        self.assertIn('黑棋', answer['text'])
        assisted = snapshot(seat_label='黑方', assisted={
            'legalActions': [{'move': 'H8'}],
            'immediateWins': ['H8'],
            'mustBlocks': [],
        })
        move = await self.service.move(
            self.session, ORIGIN, MATCH, 'black', assisted, feedback='上次坐标越界', request_id='req-1'
        )
        self.assertEqual(move['raw'], '{"move":"H8","say":"我先占中间。"}')
        self.assertIn('规则辅助模式', self.model.calls[1]['prompt'])
        self.assertEqual(self.model.calls[1]['data']['feedback'], '上次坐标越界')
        self.assertEqual(self.model.calls[1]['data']['seat'], 'black')
        self.assertEqual(self.model.calls[1]['data']['role'], 'player')
        # 通用座位 ID 不再被硬编码为 black/white。
        await self.service.move(self.session, ORIGIN, MATCH, 'star', snapshot(seat_label='星席'))
        self.assertEqual(self.model.calls[2]['data']['seat'], 'star')
        self.assertFalse(self.speak.calls)

    async def test_nonhuman_opponent_is_distinct_from_owner_in_all_requests(self):
        self.model.responses = ['我赢了二号位机器人。', '主人在观战，我的对手是机器人。', '{"move":"H8"}']
        board = snapshot(outcome={'type': 'win', 'winnerSeat': 'black'})
        board['seats'] = [
            {'id': 'black', 'name': '黑方', 'kind': 'dafeiyu', 'participantName': '大肥鱼'},
            {'id': 'white', 'name': '白方', 'kind': 'bot', 'participantName': '内置机器人'},
        ]
        await self.service.comment(self.session, ORIGIN, MATCH, 'player', 'black', board,
                                   {'key': 'identity-end', 'type': 'game_end'})
        await self.service.question(self.session, ORIGIN, MATCH, 'player', 'black', board, '你赢了谁？')
        await self.service.move(self.session, ORIGIN, MATCH, 'black', board)
        for call in self.model.calls:
            self.assertIn('白方由内置机器人控制', call['prompt'])
            self.assertIn('主人只在场外观战', call['prompt'])
            self.assertIn('角色称呼服从这份参赛名单', call['prompt'])

    async def test_human_model_and_legacy_rosters_have_explicit_identity(self):
        self.model.responses = ['测试回答'] * 3
        board = snapshot()
        board['seats'][0]['kind'] = 'human'
        board['seats'][1].update(kind='model', participantName='测试模型')
        await self.service.question(self.session, ORIGIN, MATCH, 'observer', None, board, '谁在下？')
        prompt = self.model.calls[-1]['prompt']
        self.assertIn('真人座位是黑方', prompt)
        self.assertIn('白方由普通模型控制，名称为测试模型', prompt)
        board['seats'] = {'black': {'name': '黑方', 'kind': 'human'}}
        await self.service.question(self.session, ORIGIN, MATCH, 'observer', None, board, '谁在下？')
        self.assertIn('真人座位是黑方', self.model.calls[-1]['prompt'])
        await self.service.question(self.session, ORIGIN, MATCH, 'observer', None, snapshot(), '谁在下？')
        self.assertIn('主人的参赛身份未知', self.model.calls[-1]['prompt'])

    async def test_repeated_comment_is_skipped_without_poisoning_history(self):
        text = '我先补上蓝色折扣，下回合看看那张两分牌。'
        self.model.responses = ['（甩尾巴）' + text, '（轻轻甩尾）' + text]
        board = snapshot()
        board['recentChat'] = [{'role': 'dafeiyu', 'kind': 'comment', 'text': '旧的六分卡说法'}]
        await self.service.comment(self.session, ORIGIN, MATCH, 'player', 'black', board, {'key': 'one'})
        with self.assertRaises(ArenaError) as repeated:
            await self.service.comment(self.session, ORIGIN, MATCH, 'player', 'black', board, {'key': 'two'})
        self.assertEqual(repeated.exception.code, 'comment_skipped')
        self.assertEqual(self.model.calls[0]['data']['snapshot']['recentChat'], [])
        self.assertNotIn('_previousSpeech', self.model.calls[0]['data'])

    async def test_card_points_and_actor_are_checked_before_comment_is_displayed(self):
        board = snapshot()
        board['state']['players'] = {'black': {'points': 0}, 'white': {'points': 2}}
        event = {'key': 'purchase', 'details': {'actor': 'black', 'card': {'id': '1G6', 'points': 0},
                                               'scoreAfter': 0, 'pointsGained': 0}}
        self.model.responses = ['本鲸刚拿下这张 6 分卡，真划算。', '本鲸稳稳领先！']
        for key in ('card', 'leader'):
            with self.assertRaises(ArenaError) as invalid:
                await self.service.comment(self.session, ORIGIN, MATCH, 'player', 'black', board, {**event, 'key': key})
            self.assertEqual(invalid.exception.code, 'comment_skipped')
        self.model.responses = ['本鲸刚买下这张卡。']
        with self.assertRaises(ArenaError) as observer:
            await self.service.comment(self.session, ORIGIN, MATCH, 'observer', None, board, event)
        self.assertEqual(observer.exception.code, 'comment_skipped')

    async def test_question_corrects_identity_once_and_move_keeps_action_when_speech_repeats(self):
        board = snapshot()
        board['seats'] = [
            {'id': 'black', 'name': '黑方', 'kind': 'dafeiyu'},
            {'id': 'white', 'name': '白方', 'kind': 'model', 'participantName': 'DS'},
        ]
        self.model.responses = ['仆人你那点分不够看。', '主人，我的对手是白方 DS。']
        result = await self.service.question(self.session, ORIGIN, MATCH, 'player', 'black', board, '我在下棋吗？')
        self.assertIn('白方 DS', result['text'])
        self.assertIn('correction', self.model.calls[-1]['data'])
        self.model.responses = ['{"move":"H8","say":"（尾巴甩）本鲸就选这个，别挡路～"}']
        result = await self.service.move(self.session, ORIGIN, MATCH, 'black', board)
        import json
        self.assertEqual(json.loads(result['raw']), {'move': 'H8', 'say': ''})

    async def test_voice_uses_current_validity_dedup_key_and_cancel(self):
        result = await self.service.speak(self.session, ORIGIN, MATCH, '我先堵右边。', 'evt/1')
        self.assertEqual(result['voiceStatus'], 'queued')
        call = self.speak.calls[0]
        self.assertIn(f'arena-{self.session}-', call['key'])
        self.assertNotIn('/', call['key'])
        self.assertTrue(call['valid']())
        cancelled = self.service.cancel_speech(self.session, ORIGIN, MATCH)
        self.assertEqual(cancelled['cancelled'], 1)
        self.assertEqual(self.cancel_voice.calls[-1], f'arena-{self.session}-')
        self.service.leave(self.session, ORIGIN, MATCH)
        self.assertFalse(call['valid']())

    async def test_voice_disabled_and_errors_do_not_break_game(self):
        service = ArenaService(model=self.model, speak=None, persona=lambda: '大肥鱼', clock=lambda: self.now[0])
        token = service.connect(ORIGIN, MATCH)['sessionId']
        result = await service.speak(token, ORIGIN, MATCH, 'hello', 'k')
        self.assertEqual(result['voiceStatus'], 'unavailable')
        self.model.responses = [RuntimeError('model down')]
        with self.assertRaises(ArenaError) as error:
            await service.move(token, ORIGIN, MATCH, 'black', snapshot())
        self.assertEqual(error.exception.status, 502)
        self.assertEqual(error.exception.code, 'model_error')

    async def test_ttl_and_concurrency_cap_and_supersede(self):
        self.now[0] += 15 * 60 + 1
        with self.assertRaises(ArenaError):
            self.service.status(self.session, ORIGIN, MATCH)
        tokens = []
        for index in range(8):
            tokens.append(self.service.connect(ORIGIN, f'm-{index}')['sessionId'])
        with self.assertRaises(ArenaError) as full:
            self.service.connect(ORIGIN, 'm-over')
        self.assertEqual(full.exception.status, 429)
        # 同局重连应取代旧会话而不是继续占用名额。
        replacement = self.service.connect(ORIGIN, 'm-0')['sessionId']
        self.assertNotEqual(replacement, tokens[0])
        with self.assertRaises(ArenaError):
            self.service.status(tokens[0], ORIGIN, 'm-0')

    async def test_text_and_endpoint_sanitizers(self):
        self.assertEqual(_clean_text('“  说重点。 ”', 80), '说重点。')
        self.assertEqual(_clean_text('回答：这一手不错。', 80), '这一手不错。')
        self.assertEqual(_model_url(), 'http://127.0.0.1:18200/v1/chat/completions')

    async def test_move_prioritizes_over_inflight_comment(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def model(prompt, data, max_tokens=None):
            if 'event' in data:
                started.set()
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            return '{"move":"A1"}'

        service = ArenaService(
            model=model,
            cancel_voice=self.cancel_voice,
            persona=lambda: '大肥鱼',
            clock=lambda: self.now[0],
        )
        token = service.connect(ORIGIN, MATCH)['sessionId']
        comment_task = asyncio.create_task(service.comment(
            token, ORIGIN, MATCH, 'observer', None, snapshot(),
            {'key': 'threat:black:A1', 'type': 'threat', 'summary': '黑方 A1 成五。'},
        ))
        await asyncio.wait_for(started.wait(), timeout=1)
        move = await asyncio.wait_for(
            service.move(token, ORIGIN, MATCH, 'black', snapshot()),
            timeout=2,
        )
        self.assertEqual(move['raw'], '{"move":"A1"}')
        await asyncio.wait_for(cancelled.wait(), timeout=1)
        with self.assertRaises(ArenaError) as error:
            await asyncio.wait_for(comment_task, timeout=2)
        self.assertEqual(error.exception.code, 'comment_skipped')

    async def test_busy_states_do_not_turn_into_disconnects(self):
        move_started = asyncio.Event()
        release_move = asyncio.Event()

        async def model(prompt, data, max_tokens=None):
            if 'seat' in data:
                move_started.set()
                await release_move.wait()
                return '{"move":"A1"}'
            return 'comment'

        service = ArenaService(model=model, persona=lambda: '大肥鱼', clock=lambda: self.now[0])
        token = service.connect(ORIGIN, MATCH)['sessionId']
        move_task = asyncio.create_task(service.move(token, ORIGIN, MATCH, 'black', snapshot()))
        await asyncio.wait_for(move_started.wait(), timeout=1)
        with self.assertRaises(ArenaError) as comment_error:
            await service.comment(token, ORIGIN, MATCH, 'observer', None, snapshot(), {'key': 'k'})
        self.assertEqual(comment_error.exception.code, 'comment_skipped')
        with self.assertRaises(ArenaError) as question_error:
            await service.question(token, ORIGIN, MATCH, 'observer', None, snapshot(), '在吗')
        self.assertEqual(question_error.exception.code, 'player_busy')
        release_move.set()
        await asyncio.wait_for(move_task, timeout=2)

    async def test_leave_cancels_inflight_move(self):
        started = asyncio.Event()

        async def model(prompt, data, max_tokens=None):
            started.set()
            await asyncio.sleep(5)
            return '{"move":"A1"}'

        service = ArenaService(model=model, persona=lambda: '大肥鱼', clock=lambda: self.now[0])
        token = service.connect(ORIGIN, MATCH)['sessionId']
        move_task = asyncio.create_task(service.move(token, ORIGIN, MATCH, 'black', snapshot()))
        await asyncio.wait_for(started.wait(), timeout=1)
        service.leave(token, ORIGIN, MATCH)
        with self.assertRaises(ArenaError) as error:
            await asyncio.wait_for(move_task, timeout=2)
        self.assertEqual(error.exception.code, 'cancelled')
        with self.assertRaises(ArenaError):
            service.status(token, ORIGIN, MATCH)


class PresentationCancelTests(unittest.TestCase):
    def test_cancel_only_waiting_jobs_with_prefix(self):
        class Queue:
            jobs = {
                'arena-s1-a': {'status': 'queued', 'valid': None},
                'arena-s1-b': {'status': 'playing', 'valid': None},
                'arena-other': {'status': 'queued', 'valid': None},
                'arena-s1-c': {'status': 'played', 'valid': None},
            }

        class Handler:
            _speech_queues = {'u': Queue()}

        count = cancel_jobs(Handler(), 'arena-s1-')
        self.assertEqual(count, 1)
        self.assertEqual(Queue.jobs['arena-s1-a']['status'], 'cancelled')
        self.assertFalse(Queue.jobs['arena-s1-a']['valid']())
        self.assertEqual(Queue.jobs['arena-s1-b']['status'], 'playing')
        self.assertEqual(Queue.jobs['arena-other']['status'], 'queued')


class ArenaRouteTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel(['你好。', '{"move":"A1"}'])
        self.cancel_voice = FakeCancelVoice()
        self.service = ArenaService(
            model=self.model,
            speak=FakeSpeak(),
            cancel_voice=self.cancel_voice,
            persona=lambda: '大肥鱼',
            clock=time.time,
        )
        self.app = FastAPI()
        self.app.include_router(build_router(object(), service=self.service))
        self.client = TestClient(self.app)

    def post(self, operation, payload, *, origin=ORIGIN, token=None):
        headers = {}
        if origin:
            headers['Origin'] = origin
        if token:
            headers['X-Arena-Token'] = token
        return self.client.post(f'/api/game/arena/{operation}', json=payload, headers=headers)

    def test_origin_required_and_token_optional(self):
        missing = self.client.post('/api/game/arena/connect', json={'matchId': MATCH})
        self.assertEqual(missing.status_code, 403)
        bad = self.post('connect', {'matchId': MATCH}, origin='http://evil.example')
        self.assertEqual(bad.status_code, 403)
        good = self.post('connect', {'matchId': MATCH})
        self.assertEqual(good.status_code, 200)
        self.assertTrue(good.json()['ok'])
        with patch.dict(settings.CONFIG, {'arena_token': 'secret-token'}):
            no_token = self.post('status', {'sessionId': good.json()['sessionId'], 'matchId': MATCH})
            self.assertEqual(no_token.status_code, 401)
            wrong = self.post(
                'status', {'sessionId': good.json()['sessionId'], 'matchId': MATCH},
                token='wrong',
            )
            self.assertEqual(wrong.status_code, 401)
            right = self.post(
                'status', {'sessionId': good.json()['sessionId'], 'matchId': MATCH},
                token='secret-token',
            )
            self.assertEqual(right.status_code, 200)

    def test_full_route_flow_unknown_operation_and_speech_cancel(self):
        session = self.post('connect', {'matchId': MATCH}).json()['sessionId']
        comment = self.post('comment', {
            'sessionId': session, 'matchId': MATCH, 'role': 'observer', 'seat': None,
            'snapshot': snapshot(), 'event': {'key': 'e', 'type': 'threat'},
        })
        self.assertEqual(comment.status_code, 200)
        self.assertEqual(comment.json()['text'], '你好。')
        move = self.post('move', {
            'sessionId': session, 'matchId': MATCH, 'seat': 'black', 'snapshot': snapshot(),
        })
        self.assertEqual(move.status_code, 200)
        self.assertEqual(move.json()['raw'], '{"move":"A1"}')
        cancelled = self.post('speak-cancel', {
            'sessionId': session, 'matchId': MATCH,
        })
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()['cancelled'], 1)
        self.assertEqual(self.cancel_voice.calls[-1], f'arena-{session}-')
        unknown = self.post('dance', {'sessionId': session})
        self.assertEqual(unknown.status_code, 404)
        left = self.post('leave', {'sessionId': session, 'matchId': MATCH})
        self.assertEqual(left.status_code, 200)


if __name__ == '__main__':
    unittest.main()
