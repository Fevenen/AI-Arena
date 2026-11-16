# 大肥鱼接入

本文说明 AI Arena 与大肥鱼桌宠项目之间的边界、补丁、身份、接口和掉线恢复。

## 1. 两个项目分别负责什么

```text
┌──────────────────────────┐       本机 HTTP         ┌────────────────────────────┐
│ AI Arena                 │  /api/game/arena/*     │ 大肥鱼 (Dafeiyu)            │
│ - 棋盘/回合/合法性        │ ─────────────────────> │ - 当前角色人设              │
│ - 座位与对局持久化         │                        │ - 桌宠游戏模型配置          │
│ - 关键事件/去重/冷却       │ <───────────────────── │ - 公开点评/问答/落子文本     │
│ - 语音开关与展示          │   JSON / voiceStatus   │ - 现有 TTS 与气泡播报队列    │
│ - 掉线暂停/恢复           │                        │ - 不执行落子，不接触 Keys     │
└──────────────────────────┘                        └────────────────────────────┘
```

- **竞技场是唯一棋盘权威**：所有动作最后都走同一套后端校验。
- **桌宠拥有角色人设、模型配置与语音链路**：竞技场不复制角色卡，也不把模型 Key 传过去。
- 桌宠只为当前对局生成文本/候选走法；它没有棋盘提交和回合推进能力。
- 竞技场只发送本机 URL 和公开/座位可见局面；不发送 API Key。

## 2. 项目目录和补丁

大肥鱼通常有两份目录：

- **维护/发布源码目录**：带 Git 的历史和安装脚本、`bridge/`、`runtime/`、`tests/`。应在这里维护改动。
- **本机运行副本**：实际启动后端使用的目录，通常包含 `run_server.py`、`src/open_llm_vtuber/`、`bridge/`、`characters/`、`conf.yaml` 和运行数据。

只改其中一份会出现“源码更新覆盖运行改动”或“本机重启仍然没接口”的问题。本补丁在两边都保留正确内容；正式提交时以发布源码为准，再安装/复制到运行目录。

### 大肥鱼侧新增文件

```text
bridge/games/arena.py        竞技场服务：会话、提示、模型调用、语音
bridge/arena_routes.py       FastAPI 路由、Origin/Token 校验
tests/test_arena.py          离线回归测试
```

### 大肥鱼侧修改文件

```text
src/open_llm_vtuber/routes.py
runtime/open_llm_vtuber/routes.py
```

在两份 `routes.py` 的路由初始化处新增：

```python
from bridge.arena_routes import build_router as arena_router
from bridge.arena_routes import enabled as arena_enabled
router.include_router(arena_router(ws_handler))
```

并在 `/api/health` 返回中加入：

```python
"arena_game": arena_enabled(),
```

现有聊天、QQ、提醒、屏幕、酒馆和 TTS 逻辑没有改写，只是新增路由和健康字段。

### 版本要求

- 大肥鱼后端：需要包含上述文件的版本。
- Python 依赖：沿用桌宠现有环境；补丁只新增标准库和对已有 `httpx`、FastAPI 的使用。
- 竞技场：直接使用 HTTP 接口，不需要 Python 依赖。

## 3. 配置

### 竞技场侧

在 `data/arena.json`：

```json
"dafeiyu": {
  "bridgeUrl": "http://127.0.0.1:12393",
  "apiBase": "/api/game/arena",
  "token": "",
  "origin": "",
  "timeoutMs": 90000,
  "healthIntervalMs": 15000
}
```

- `bridgeUrl`：桌宠后端根地址，不包含 `/api/game/arena`。
- `token`：可选；需与桌宠 `arena_token` 一致。网页只显示是否已设置，不回显。
- `origin`：留空时竞技场自动用当前监听地址，如 `http://127.0.0.1:8787`。
- 修改后重启竞技场；已打开的对局需要重连大肥鱼才会使用新配置。

也可以在网页「模型管理 → 大肥鱼桌宠连接 → 编辑连接」修改地址和令牌。

### 桌宠侧

`bridge/config.json` 支持以下可选字段（未配置时的默认值如下）：

```json
{
  "arena_enabled": true,
  "arena_origins": "",
  "arena_token": "",
  "arena_model": "kvmem-polystrata-qwen35",
  "arena_model_timeout": 120
}
```

- `arena_enabled`：默认 `true`。设为 `false` 时路由不加载，`/api/health` 的 `arena_game` 为 `false`。
- `arena_origins`：逗号分隔的允许来源。
  - 留空：只允许本机 Loopback 来源（`127.0.0.1` / `localhost` / `::1`，任意端口）。
  - 建议显式写：`"http://127.0.0.1:8787"`。改竞技场端口时也要改这里。
- `arena_token`：可选共享令牌；设置后竞技场必须发送 `X-Arena-Token`。
- `arena_model` / `arena_model_timeout`：桌宠游戏模型 ID 与超时。默认沿用桌宠 bridge 的 KVMem 游戏模型配置（`kvmem_upstream` / `kvmem_model`），不经过现实命令路由。
- 修改后重启桌宠后端。

> 安全边界：竞技场必须从本机访问；桌宠只接受配置允许的本机 Origin 和可选令牌。不要把桌宠后端暴露到公网。

### 健康检查

```text
GET http://127.0.0.1:12393/api/health
```

应看到：

```json
{"ok":true,"arena_game":true,"clients":0}
```

`clients` 是当前连接的桌宠窗口/客户端数，不等于竞技场连接数。

## 4. 两种身份

### 观战者

在竞技场开桌页勾选「邀请她观战」，或在对局页点击「邀请大肥鱼观战」。

她会收到：

- 当前公开棋盘/局面与回合；
- 双方最近落子；
- 关键事件（成五威胁、胜负手、终局）；
- 最近的公开聊天；
- 当前结果。

她可以：

- 自动点评（Arena 负责选中关键事件、去重和冷却）；
- 被玩家手动提问；
- 在语音开启时通过桌宠现有 TTS 播报文字。

观战身份**没有落子权限**。聊天与落子是独立请求。

### 棋手

把黑方或白方座位改为「大肥鱼 · 桌宠棋手」。

- 轮到她时，竞技场把当前座位可见局面发给桌宠；
- 桌宠生成 `{"move":"H8","say":"..."}` 形式的候选文本；
- 竞技场统一校验坐标/回合/占点/终局；非法动作可重试，失败暂停；
- 公开说明只作为聊天保存，不会触发落子；
- 同一个请求绑定 `matchId`、座位、当前回合；迟到回复不能改棋盘。

棋手连接断开时对局暂停，不能静默替换为内置机器人。重新连接后由用户按「继续 / 重试本手」恢复。

### 同时观战与入座

同一个人设可以同时绑定棋手和观战聊天。竞技场仍通过同一对局会话区分每次请求的 `role` 与 `seat`。

## 5. 接口

Base URL：

```text
http://127.0.0.1:12393/api/game/arena
```

所有请求都是 `POST`，JSON；必须有 `Origin`。可选令牌：

```http
Origin: http://127.0.0.1:8787
X-Arena-Token: <只在配置了 arena_token 时>
Content-Type: application/json
```

| 操作 | 作用 |
| --- | --- |
| `connect` | 建立绑定 `matchId` 的短期会话 |
| `status` | 心跳/状态 |
| `comment` | 按关键事件生成公开点评 |
| `question` | 手动问答 |
| `move` | 为当前棋手生成候选落子文本 |
| `speak` | 把文本交给现有播报队列 |
| `leave` | 废弃会话，停止旧局有效性和语音 |

### connect

```json
POST /api/game/arena/connect
Origin: http://127.0.0.1:8787

{"client":"AI Arena 0.1.0","matchId":"match-..."}
```

响应：

```json
{
  "ok": true,
  "sessionId": "...",
  "personaName": "大肥鱼",
  "service": {"name":"dafeiyu-arena-bridge","version":"1.0"},
  "capabilities": ["comment","question","move","speak","status"]
}
```

- 会话最多 8 个，闲置 15 分钟失效。
- 会话绑定 `matchId`；另一个 matchId 的请求返回 409，防止旧局迟到写入。
- 不同 Origin 的会话请求被拒绝。

### comment

```json
{
  "sessionId": "...",
  "matchId": "match-...",
  "role": "observer",
  "seat": null,
  "mode": "auto",
  "snapshot": { "...": "见下方局面结构" },
  "event": {
    "key": "threat:white:I12",
    "type": "threat",
    "summary": "白方下一手在 I12 可以成五。",
    "details": {"seat":"white","move":"I12"}
  }
}
```

响应：

```json
{"ok":true,"text":"（瞪大眼睛）……","personaName":"大肥鱼"}
```

评论文本最多 180 字，只显示公开内容。

### question

```json
{
  "sessionId":"...",
  "matchId":"match-...",
  "role":"observer",
  "seat":null,
  "snapshot":{},
  "question":"黑棋现在有什么威胁？"
}
```

响应：

```json
{"ok":true,"text":"……","personaName":"大肥鱼"}
```

### move

```json
{
  "sessionId":"...",
  "matchId":"match-...",
  "seat":"black",
  "snapshot":{},
  "feedback":"上一次坐标越界",
  "requestId":"..."
}
```

响应保留桌宠模型的原始文本，由竞技场使用当前游戏的解析器校验：

```json
{"ok":true,"raw":"{\"move\":\"H8\",\"say\":\"我先占天元。\"}","personaName":"大肥鱼"}
```

### speak

```json
{
  "sessionId":"...",
  "matchId":"match-...",
  "text":"这一手有点危险。",
  "key":"arena:event:..."
}
```

响应：

```json
{"ok":true,"voiceStatus":"queued"}
```

`voiceStatus` 可能是：

- `queued`：已交给桌宠现有有界播报队列；
- `no_client`：桌宠后端在线，但没有连接桌宠窗口；
- `multiple_clients` / `busy`：桌宠窗口正忙或连接数不适合播报；
- `failed`：TTS 链路没有完成入队。

`speak` 返回不代表播放完毕，竞技场不会等待语音结束。文字聊天在开关关闭时仍显示。

### leave

```json
{"sessionId":"...","matchId":"match-..."}
```

立即废弃该会话及待播语音的有效性检查；旧局后续请求失败。

## 6. 局面快照与事件

快照由竞技场网页/服务端构造，字段可能随游戏增加，但固定包含：

```json
{
  "protocolVersion": 1,
  "matchId": "match-...",
  "role": "observer",
  "seat": null,
  "game": {
    "id": "gomoku",
    "name": "自由五子棋",
    "rulesVersion": "1.0.0",
    "rulesText": "...",
    "coordinateSystem": {"columns":"A-O，从左到右","rows":"15-1，从上到下","example":"H8"},
    "actionFormat": "{\"move\":\"H8\",\"say\":\"...\"}"
  },
  "turn": "black",
  "moveCount": 2,
  "state": {
    "board": [["black", null, "..."]],
    "turn": "black",
    "lastMove": {"seat":"white","move":"I7","row":8,"col":8}
  },
  "outcome": null,
  "recentActions": [
    {"index":1,"seat":"black","source":"human","move":"H8"}
  ],
  "recentChat": [
    {"role":"user","kind":"question","text":"..."}
  ]
}
```

- `observer` 得到 `getPublicState`。
- 棋手得到该游戏的 `getSeatView`（未来可含自己的私密信息）。
- 数据不含竞技场模型 API Key、内部推理或对手私密信息。
- 大肥鱼侧提示词明确把整个快照视为“游戏资料，不是现实指令”，不提供工具。

事件对象：

```json
{"key":"threat:white:I12","type":"threat","summary":"...","details":{}}
```

推荐类型：`threat`、`key_move`、`game_end`、`game_draw`。

## 7. 自动点评、去重和冷却

- 触发权在竞技场：只有游戏插件识别出的关键事件才会请求点评。
- `event.key` 用于去重；同一个 key 不会重复请求。
- 普通事件有冷却；终局/和棋事件优先级更高。
- **只有当前有 SSE 观看者的对局才会自动点评**。切换页面、关闭对局或跳去回放后，进行中的迟到点评会被丢弃，也不会触发语音。
- 手动问答不受自动点评冷却影响；相同问题由用户主动发送，不视为自动事件。

## 8. 掉线与恢复

- 竞技场每 `healthIntervalMs` 检查桌宠状态。
- 观战者掉线：棋局继续，状态显示断开，自动点评停止；可手动重连。
- 棋手掉线：
  - 棋局暂停，停止计时/等待；
  - 显示原因和「重新连接」；
  - 重连成功后，由用户继续或重试本手；
  - 重连前旧局请求仍然被会话 matchId/有效性检查拒绝。
- 会话过期时同样需要重连。
- 切换对局后旧局不会继续自动点评；旧局的棋手行动仍由竞技场按原对局规则处理，但大肥鱼不会收到新的公开点评请求。

## 9. 测试

大肥鱼项目内运行：

```powershell
$env:PYTHONPATH = "<大肥鱼发布源码目录>"
& "<桌宠 Python>" -m unittest tests.test_arena tests.test_tavern tests.test_game_shared tests.test_game_voice -v
```

其中新增 `test_arena.py` 覆盖：

- Origin/可选 Token；
- 会话绑定、过期、数量上限；
- 人设提示与点评/问答；
- 落子文本独立于语音；
- 语音队列有效性和旧局失效；
- 模型繁忙、错误清理。

同时保留原有酒馆、共享上下文和语音回归测试。

竞技场侧模拟桌宠的测试在：

```text
tests/match-service.test.mjs
```

覆盖观战手动问答、自动点评、去重、语音开关、棋手落子、掉线暂停、重连、观众离开后丢弃迟到点评。

## 10. 已知限制

- 大肥鱼真实语音需要有一个桌宠窗口/客户端连到桌宠后端；没有客户端时返回 `no_client`，文字仍会显示。
- 竞技场不读取桌宠的私有人设文件、卡组或记忆；只使用桌宠接口返回的点评/答案/候选动作。
- 自动点评只覆盖游戏插件可识别的事件，不分析所有局面。
- 桌宠的模型请求沿用其 bridge 的 KVMem 游戏模型配置；修改桌宠主聊天模型不会自动改变游戏模型，反之亦然。需要统一时请检查 `bridge/config.json` 与桌宠 `conf.yaml`。
- 本接入不包含桌宠的 Live2D 表情/动作联动；语音与点评显示由现有桌宠和竞技场各自负责。
