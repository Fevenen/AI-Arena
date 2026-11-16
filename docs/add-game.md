# 添加桌游

AI Arena 的平台层负责游戏库、座位、回合、AI 调度、模型提示、记录、可见性和回放。正式游戏仍然只有自由五子棋；`tests/fixtures/three-seat-game.mjs` 是一个**只用于开发/测试**的三座位插件，用来证明新增游戏不需要改大厅、对局调度、模型客户端或大肥鱼桥。

## 1. 插件放在哪里

```text
packages/games/
  index.mjs             正式游戏注册位置
  gomoku/
    index.mjs
    rules.mjs
  <your-game>/
    index.mjs
    rules.mjs
tests/fixtures/
  three-seat-game.mjs   三座位测试插件（带私有目标）
```

正式注册：

```js
// packages/games/index.mjs
import gomokuGame from './gomoku/index.mjs';
import yourGame from './your-game/index.mjs';

export const GAME_PLUGINS = Object.freeze([gomokuGame, yourGame]);
```

测试或开发环境也可以不改注册表，在 `createArenaApp({ gamePlugins: [gomokuGame, testGame] })` 或 `MatchService({ gamePlugins })` 注入额外插件。网页从 `/api/games` 和 `/api/bootstrap.games` 读取列表，按插件声明自动生成游戏卡片和座位。

## 2. 插件接口

用 `packages/core/game-api.mjs` 的 `defineGamePlugin` 包装。启动时会校验必要字段、座位 id 唯一性和人数。

```js
import { defineGamePlugin } from '../../core/game-api.mjs';

export default defineGamePlugin({
  id: 'lowercase-id',                    // 小写字母/数字/连字符
  name: '中文游戏名',
  shortName: '短名',
  description: '一句话说明',
  rulesVersion: '1.0.0',

  minPlayers: 2,
  maxPlayers: 3,
  supportsSpectator: true,
  seats: [
    { id: 'sun', name: '金席', shortName: '金', color: 'gold', order: 1 },
    { id: 'moon', name: '月席', shortName: '月', color: 'blue', order: 2 },
    { id: 'star', name: '星席', shortName: '星', color: 'violet', order: 3 },
  ],

  rulesText: '给模型和玩家看的规则正文',
  coordinateSystem: { note: '动作格式说明，可空' },
  ui: { kind: 'custom', rows: 3, columns: 3, showCoordinates: false },

  createInitialState({ seed }) { /* 可 JSON 序列化；随机/发牌用 seed 或 randomEvents */ },
  getPublicState(state) { /* 绝不包含隐藏信息 */ },
  getSeatView(state, seatId) { /* 该座位可见信息；可含自己的私有目标/手牌 */ },
  getCurrentActor(state) { /* 返回当前行动座位 id，或 null */ },
  legalActions(state, seatId) { /* 可选；规则辅助模式会展示 */ },
  validateAction(state, seatId, action) { /* 返回 {ok, action, code, message} */ },
  applyAction(state, seatId, action) { /* 不可变更新，返回 {state, event} */ },
  getOutcome(state) { /* null 或 {type:'win'|'draw', winnerSeat, ...} */ },

  describeForModel({ state, seatId, recentActions }) {
    return {
      gameName, rulesText, seatLabel,
      boardText: '规范化局面文本',
      lastMove,
      responseFormat: '{"cell":5,"say":"可选"}',
      // 可选：只给这个 AI 座位的私有上下文
      privateContext: { /* 从 getSeatView 提取 */ },
    };
  },
  parseModelMove(text) { /* 严格解析单个 JSON 动作 */ },
  describeAction(action) { /* 给日志/聊天/终局引用，如“第 5 格” */ },

  // 可选
  getTacticalHints({ state, seatId }) {
    return {
      legalActions: [],
      immediateWins: [],
      mustBlocks: [],
      doubleThreatMoves: [],
      notes: [],
    };
  },
  chooseBotAction({ state, seat, seed }) { /* 内置机器人 */ },
  autoCommentCandidates({ previous, state, action, chat }) {
    // action 是平台的动作记录：{ seat, action:{...}, ... }
    return [{ key, type, priority, summary, details }];
  },
});
```

## 3. 必须遵守的规则

### 座位与回合

- `seats` 是完整座位表，不要求叫 black/white；平台按 `order` 生成配置。
- `getCurrentActor(state)` 决定调度；没有它时才回退到 `state.turn`。
- 平台目前最多支持一位真人、一个大肥鱼棋手，其余座位可混合模型和内置机器人。
- `validateAction` 必须自己检查回合、动作格式、空位/可用资源与终局，不能信任模型或网页。

### 公开视图与私有视图

- `getPublicState` 会进入：网页、SSE、公开 API、导出、回放公开快照。
- `getSeatView` 只给该座位模型的提示和大肥鱼棋手快照。
- 私有字段不要放进 public view；测试插件用 `SUN-SECRET-TARGET` 等标记验证公开 API/SSE/导出不泄露。
- 平台不会把原始 `match.state` 直接返回给网页；即使插件状态里有私有信息，出口只调用这两个函数。

### 结构化动作与两种模式

- `parseModelMove` 必须拒绝自由文本、含糊、多动作、截断和非法动作；返回 `ok:false` 会让调度器有限重试，耗尽后暂停。
- `responseFormat` 是给模型的必填格式说明。
- **纯模型**只拿到规则、公开局面/座位可见信息和格式；平台不注入合法候选或战术提示。
- **规则辅助**额外把 `legalActions` 和 `getTacticalHints` 的结果交给模型；插件应尽量提供可验证的立即胜负点/必堵点。
- 大肥鱼棋手沿用同一套 snapshot；桥不写死黑色/白色。

### 终局与 UI

- `getOutcome` 返回 `winnerSeat` 必须是存在的座位 id；和棋用 `{type:'draw'}`。
- 建议在 outcome 中同时写真实最后一手字段（例如 `move` 或 `cell`），终局点评和 UI 会引用它，避免 undefined。
- `applyAction` 的 `event` 是公开事件；事件的私有信息会由平台过滤，插件仍不要把隐藏状态放进去。
- `describeAction` 用于最后一手、回放和逐手指标；不要使用 `JSON.stringify` 作为唯一展示。

### 回放与随机

平台在每一步后保存权威公开快照和每个座位视图，回放默认不再调用 `applyAction`，所以旧插件版本变化后仍能打开有快照的旧局。

- 新对局从第 0 步开始保存快照。
- 旧记录若没有快照，平台仅在 `match.rulesVersion === game.rulesVersion` 时补建；不同版本且无快照会明确报错。
- 未来发牌/掷骰：把公开随机结果写进 `match.randomEvents`，或把随机结果纳入插件状态；平台快照会保留 `seed` 与 `randomEvents`。
- 已有棋谱的 `rulesVersion` 不要随意修改；规则变化时递增版本。

## 4. 测试插件：三座位

`tests/fixtures/three-seat-game.mjs` 是一个最小但完整的示例：

- 三个座位 `sun/moon/star`，顺序 `金→月→星`；
- 3×3 桌面，三连获胜；
- 九格占满时由**私有目标格**决定唯一赢家；
- `getPublicState` 隐藏目标，`getSeatView` 显示自己的目标和提示；
- 有 `getCurrentActor`、合法动作、结算、严格 JSON 解析、内置机器人、专属网页组件（`GAME_SURFACES['three-seat-test']`）。

测试中：

```js
const games = [gomokuGame, threeSeatGame];
const app = await createArenaApp({ configPath, gamePlugins: games });
```

或：

```js
const harness = await createServiceHarness({ gamePlugins: games });
const match = await harness.service.createMatch({
  gameId: 'three-seat-test',
  seats: { sun: { kind: 'bot' }, moon: { kind: 'bot' }, star: { kind: 'bot' } },
  dafeiyu: { enabled: false },
});
```

测试覆盖：

- 游戏库/API 出现三席游戏；
- 逐座位行动和终局；
- 公开 API、SSE、导出、回放都不含私有目标；
- 模型提示包含自己的私有目标、不包含其他座位目标；
- 规则版本变化后旧局仍用快照回放；
- 私有目标结算。

正式发布默认只注册五子棋；不要把测试插件加进 `GAME_PLUGINS`。

## 5. 专属网页组件

网页的 `GAME_SURFACES` 注册表按 `gameId` 选择桌面组件：

```js
const GAME_SURFACES = {
  gomoku: (ctx) => boardCard(ctx),
  'your-game': ({ match, view, interactive, humanColor }) => yourSurface({
    match, view, interactive, humanColor,
  }),
};
```

组件收到：

- `match`：公开对局、座位、聊天、状态、逐手动作；
- `view`：当前 `getPublicState` 结果；
- `interactive`：真人是否可操作；
- `humanColor`：人类座位 id（通用命名，实际可为任意 id）；
- `title`。

交互动作提交到：

```text
POST /api/matches/:id/actions
{ "seat": "sun", "action": { "cell": 5 }, "clientActionId": "..." }
```

没有专属组件时，网页显示只读的通用局面摘要；历史仍可打开，但新游戏可能无法交互。测试插件展示了 `data-action="play-cell"` 的简单实现。

## 6. 测试清单

为新游戏新增 `tests/<game>.test.mjs`，至少覆盖：

1. 初始状态、座位顺序和当前行动者；
2. 合法/非法动作、错误座位、错误回合；
3. 终局、和棋与不允许继续；
4. 不可变状态和重复动作幂等；
5. 严格模型解析：合法 JSON、代码围栏、歧义、多动作、截断、非法值；
6. public view 不含私有字段，seat view 只含自己的私有字段；
7. 规则辅助提示（如果提供）与内置机器人合法；
8. `rulesVersion` 变化后仍能用快照回放；
9. 专属网页组件或通用 fallback 可打开；
10. 导出不含 Key 和私有状态。

启动并运行全部：

```powershell
node --test --test-concurrency=1
```

浏览器验收（自动启动隔离服务）：

```powershell
node scripts/ui-smoke.mjs
```

## 7. 不要修改的地方

新增游戏时**不要**在 `match-service.mjs`、`match-store.mjs`、`app.mjs` 中增加游戏分支；也不要硬编码 black/white 或某个坐标。若接口确实不足，先改核心接口并在本文更新契约，再改插件和测试。
