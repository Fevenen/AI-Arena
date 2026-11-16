# 添加桌游

第一版正式游戏只有自由五子棋，但对局调度、座位、模型调用、持久化和回放都是围绕统一插件接口写的。新增游戏只需要提供规则插件；如果需要专属棋盘/桌面，再补一个网页组件。

## 1. 插件放在哪里

```text
packages/games/
  index.mjs             唯一注册位置
  gomoku/
    index.mjs           五子棋插件
    rules.mjs           纯规则函数
  <your-game>/
    index.mjs
    rules.mjs
```

`packages/games/index.mjs`：

```js
import gomokuGame from './gomoku/index.mjs';
import yourGame from './your-game/index.mjs';

export const GAME_PLUGINS = Object.freeze([gomokuGame, yourGame]);
```

服务端和网页都通过注册表列表发现游戏；不要在 match-service 里增加游戏分支。

## 2. 必须实现的接口

使用 `packages/core/game-api.mjs` 的 `defineGamePlugin` 包装插件，启动时会校验必要字段。

```js
import { defineGamePlugin } from '../../core/game-api.mjs';

export default defineGamePlugin({
  id: 'lowercase-id',                  // 只允许小写字母、数字、连字符
  name: '中文游戏名',
  shortName: '短名',
  description: '一句话说明',
  rulesVersion: '1.0.0',
  minPlayers: 2,
  maxPlayers: 2,
  supportsSpectator: true,
  seats: [
    { id: 'black', name: '黑方', order: 1 },
    { id: 'white', name: '白方', order: 2 },
  ],
  rulesText: '给模型看的规则正文',
  coordinateSystem: { note: '给模型和网页看的动作格式说明' },
  ui: { kind: 'custom', showCoordinates: false },

  createInitialState({ seed }) { /* 返回可 JSON 序列化的状态 */ },
  getPublicState(state) { /* 返回公开局面，绝不包含私有信息 */ },
  getSeatView(state, seatId) { /* 该座位可见范围；可以加自己的手牌等 */ },
  legalActions(state, seatId) { /* 可选；用于调试/未来辅助 */ },
  validateAction(state, seatId, action) { /* 返回 {ok, action, code, message} */ },
  applyAction(state, seatId, action) { /* 返回 {state, event}；不可变更新 */ },
  getOutcome(state) { /* null 或 {type:'win'|'draw', winnerSeat, ...} */ },
  describeForModel({ state, seatId, recentActions }) { /* 构造棋盘/局面文本 */ },
  parseModelMove(text) { /* 返回 {ok, action, say} 或 {ok:false,error} */ },

  // 可选
  chooseBotAction({ state, seat, seed }) { /* 内置机器人策略 */ },
  autoCommentCandidates({ previous, state, action, chat }) {
    return []; // [{key,type,priority,summary,details}]
  },
});
```

### 各字段的硬性要求

- **`id`**：稳定、不可随意改；历史记录会用它找插件。
- **`rulesVersion`**：规则变化时递增；旧的 `match.rulesVersion` 与回放一起保存。
- **`createInitialState`**：输入包含持久化的 `seed`。未来需要随机洗牌/掷骰时，用这个 seed 做确定性随机，保证回放可复现。
- **`getPublicState`**：只返回公开信息。竞技场会把它发给观战者、网页和回放。
- **`getSeatView`**：只返回该座位可见信息；大肥鱼棋手通过此视图获取局面。未来有私有手牌时不要放进 public view。
- **`validateAction`**：必须自己检查是否轮到该座位、动作是否合法、是否终局。**不要信任模型或网页**。返回：
  - 合法：`{ok:true, action:{...规范化动作...}}`
  - 非法：`{ok:false, code:'wrong_turn', message:'现在轮到...'}`；`message` 会显示给用户并作为模型重试反馈。
- **`applyAction`**：只在前端校验通过后由后端调用；仍要使用不可变更新（不要直接改旧 state），返回新的 state 与公开事件。
- **`getOutcome`**：终局返回结果；`type:'win'` 时 `winnerSeat` 必须是座位 id；`type:'draw'` 表示和棋。不要返回 `winnerSeat` 给不存在的座位。
- **`parseModelMove`**：模型返回 `{"move":"..."}` 等结构。建议容忍 Markdown 代码围栏，但只提取一个结构化动作；解析失败返回 `ok:false`，调度器会有限重试。
- **`describeForModel`**：返回 `rulesText`、`boardText`/局面文本、`seatLabel`、`lastMove`、`responseFormat`。服务端会把它们放进模型提示。不要放隐藏信息或密钥。
- **`autoCommentCandidates`**：可选。返回 `key` 要能区分同一事件；Arena 用它做去重和冷却。事件类型推荐：
  - `threat`、`key_move`、`game_end`、`game_draw`。
  - 高优先级事件 `game_end`/`game_draw` 会绕过普通点评冷却。

### 动作和可见性

当前动作、发言和事件都带 `visibility: "public"`。未来游戏可扩展为：

- `visibility: "seat:black"` / `"seat:white"` 的动作/事件；
- 根记录中的 `privateBySeat`；
- 根记录中的 `randomEvents`；
- 初始状态里的 `seed`。

回放重建时只使用 `seed + 已接受动作`；服务端不会重放模型。未来需要发牌/掷骰时，必须把随机结果持久化或保证 seed 驱动的确定性。

## 3. 最小可用示例：取石子

下面是一个完整可运行的插件，用来演示接口。它**未注册到本项目**，复制到 `packages/games/stones/index.mjs` 并测试后才能在开桌页出现。

规则：9 颗石子，双方轮流取 1–2 颗，取到最后一颗者胜。

```js
import { defineGamePlugin } from '../../core/game-api.mjs';

const RULES = '桌面有 9 颗石子。黑方先手。每回合可取 1 颗或 2 颗。取到最后一颗石子的一方获胜。';
const LABEL = { black: '黑方', white: '白方' };

function applyAction(state, seat, action) {
  const check = validateAction(state, seat, action);
  if (!check.ok) throw Object.assign(new Error(check.message), check);
  const stones = state.stones - action.take;
  const ended = stones === 0;
  return {
    state: {
      ...state,
      stones,
      turn: ended ? null : seat === 'black' ? 'white' : 'black',
      lastAction: { seat, take: action.take },
      outcome: ended
        ? { type: 'win', winnerSeat: seat, winnerLabel: LABEL[seat] }
        : null,
    },
    event: { type: 'take', seat, take: action.take, stonesLeft: stones },
  };
}

function validateAction(state, seat, action) {
  if (state.outcome) return { ok: false, code: 'game_over', message: '对局已经结束。' };
  if (!['black', 'white'].includes(seat)) return { ok: false, code: 'unknown_seat', message: '未知座位。' };
  if (state.turn !== seat) return { ok: false, code: 'wrong_turn', message: `现在轮到${LABEL[state.turn]}。` };
  const take = Number(action?.take);
  if (![1, 2].includes(take)) return { ok: false, code: 'invalid_take', message: '只能取 1 或 2 颗石子。' };
  if (take > state.stones) return { ok: false, code: 'not_enough', message: '剩下的石子不够。' };
  return { ok: true, action: { take } };
}

const game = defineGamePlugin({
  id: 'stones',
  name: '取石子',
  shortName: '石子',
  description: '9 颗石子，轮流取 1–2 颗，取最后一颗者胜。',
  rulesVersion: '1.0.0',
  minPlayers: 2,
  maxPlayers: 2,
  supportsSpectator: true,
  seats: [
    { id: 'black', name: '黑方', order: 1 },
    { id: 'white', name: '白方', order: 2 },
  ],
  rulesText: RULES,
  coordinateSystem: { format: '{"take":1}' },
  ui: { kind: 'custom' },
  createInitialState() {
    return { stones: 9, turn: 'black', outcome: null, lastAction: null };
  },
  getPublicState(state) {
    return {
      gameId: 'stones', stones: state.stones, turn: state.turn,
      outcome: state.outcome, lastAction: state.lastAction,
    };
  },
  getSeatView(state, seatId) {
    return { ...this.getPublicState(state), yourSeat: seatId };
  },
  legalActions(state, seatId) {
    if (state.outcome || state.turn !== seatId) return [];
    return [1, 2].filter((take) => take <= state.stones).map((take) => ({ take }));
  },
  validateAction,
  applyAction,
  getOutcome(state) { return state.outcome; },
  describeForModel({ state, seatId }) {
    return {
      gameName: '取石子',
      rulesText: RULES,
      seatId,
      seatLabel: LABEL[seatId],
      boardText: `剩余 ${state.stones} 颗石子，当前轮到${LABEL[state.turn]}。`,
      lastMove: state.lastAction,
      responseFormat: '{"take":1,"say":"可选公开想法"}',
    };
  },
  parseModelMove(text) {
    const source = String(text ?? '');
    const match = /"take"\s*:\s*([12])/.exec(source);
    const take = Number(match?.[1] ?? NaN);
    if (![1, 2].includes(take)) return { ok: false, error: '缺少 take=1 或 2。' };
    const say = /"say"\s*:\s*"([^"]*)"/.exec(source)?.[1] ?? '';
    return { ok: true, action: { take }, say: say.slice(0, 120) };
  },
  chooseBotAction({ state }) {
    // 简单策略：能取完就取完，否则尽量给对方留 3 的倍数（演示用）。
    if (state.stones <= 2) return { take: state.stones };
    return { take: state.stones % 3 === 0 ? 2 : 1 };
  },
  autoCommentCandidates({ state, action }) {
    if (!state.outcome) {
      return [{ key: `stones:${state.stones}`, type: 'key_move', priority: 50, summary: `还剩 ${state.stones} 颗石子。` }];
    }
    return [{ key: `stones:end:${action.seat}`, type: 'game_end', priority: 100, summary: `${LABEL[action.seat]}取走最后一颗。` }];
  },
});

export default game;
```

### 注册

```js
// packages/games/index.mjs
import stonesGame from './stones/index.mjs';
export const GAME_PLUGINS = Object.freeze([gomokuGame, stonesGame]);
```

注册后重启服务。

### 专属网页组件

第一版网页在 `apps/web/app.js` 里有一个 `GAME_SURFACES` 注册表：

```js
const GAME_SURFACES = {
  gomoku: (ctx) => boardCard(ctx),
  stones: ({ match, view, interactive }) => renderStonesTable({ match, view, interactive }),
};
```

组件接收：

- `match`：公开对局、座位、聊天、状态；
- `view`：当前 `getPublicState` 结果；
- `interactive`：该真人当前是否可操作；
- `humanColor`：人类座位 id（如适用）；
- `title`。

组件返回 DOM 字符串。交互动作可以复用网页已有的 `api()` 提交到：

```text
POST /api/matches/:id/actions
{ "seat": "black", "action": { "take": 1 }, "clientActionId": "..." }
```

如果不加组件，历史仍可打开，网页会显示只读的通用局面摘要；新游戏可能无法在棋盘上交互，因此正式发布前应补组件。

## 4. 测试与验收

### 必测项

为插件新增 `tests/<game>.test.mjs`，覆盖：

1. 初始状态与先手；
2. 合法动作、非法动作、错误座位、错误回合；
3. 终局条件与和棋/平局条件；
4. 终局后拒绝继续行动；
5. 同一动作重复提交不改变结果；
6. 状态不可变；
7. 模型动作解析器：合法结构、代码围栏、非法内容；
8. `getPublicState` 不含私有字段；
9. 终局判断与胜者座位；
10. 若提供机器人/自动点评，覆盖去重 key。

运行：

```powershell
node --test --test-concurrency=1
```

### 端到端验收

在真实网页中：

1. 开桌页出现新游戏；
2. 真人与内置机器人能完成一局并产生结果；
3. 两个 AI 座位能自动完成一局；
4. 模型返回非法动作会暂停而不是改棋盘；
5. 对局结束、重启服务后仍可在历史中打开；
6. 回放能逐手、跳步，并同步当时的公开发言；
7. 导出记录中没有模型 Key、私有信息不越权显示；
8. 大肥鱼若启用，能收到该游戏的公开快照，或明确得到“不支持/自定义组件”的提示。

### 交给其他执行 AI 的说明

可以把本文、`packages/core/game-api.mjs`、`packages/games/gomoku/` 和一份规则/动作/计分/胜负示例一起交给执行 AI。要求它：

- 不修改 `match-service.mjs`；
- 只新增插件、注册、测试，以及必要时的网页组件；
- 按上面的验收清单逐项跑命令并报告结果；
- 规则版本、动作格式和胜负条件必须由测试固定。

网页粘贴规则自动生成游戏是后续功能，本期不实现。
