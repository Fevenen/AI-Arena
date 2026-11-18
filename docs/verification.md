# 验证记录

验证日期：2026-11-16，补充推理强度与 token 采样：2026-11-17。环境为 Windows 11、Node.js 24.16.0，本机 KVMem 与大肥鱼桌宠在线。竞技场和大肥鱼使用隔离配置/临时数据做破坏性测试；本机正式配置、Key 和已有棋谱未用于模拟测试。

## 1. 自动化测试

### AI Arena

```powershell
node --test --test-concurrency=1
```

结果：**76 项通过，0 失败**（11 个测试文件；`node --test --test-concurrency=1` 完整运行）。覆盖：

- 五子棋坐标、规则、长连、和棋、终局；
- 角斗士棋 21 块形状/朝向去重、E5/J10 起手、角接触/同色贴边/异色贴边、越界/重叠/重复、系统跳过、终局、计分和平局；
- 严格 JSON 解析、歧义/多动作/截断拒绝；
- 模型连接成功、空 Key/Bearer Key、认证/地址/模型错误、完整响应体超时和取消；
- 推理强度默认/关闭/低/高/最高的校验与 DeepSeek thinking / reasoning_effort 映射；单步输出上限校验；token usage 写入逐手指标；
- 大写小写/事件去重、机器人和规则辅助；
- 服务调度、重试、暂停/继续/单步、迟到回复丢弃；
- 大肥鱼关键卡局重放、棋手落子优先、忙/超时/解析/非法动作分类；
- 后台点评失败不判掉线、会话释放、语音取消、迟到回答作废；
- 三座位插件、逐座位行动、私有目标结算、公开 API/SSE/导出不泄露；
- 规则版本变化后快照回放；
- HTTP API、历史过滤、导出和模型 Key 不泄露。

### 大肥鱼

Arena 专项：

```powershell
python -m unittest tests.test_arena -v
```

结果：**14/14 通过**。

受影响回归（Arena + 酒馆 + 共享上下文 + 语音 + 回放 + voice regressions）：

```powershell
python -m unittest tests.test_arena tests.test_tavern tests.test_game_shared tests.test_game_voice tests.test_playback_ack tests.test_voice_regressions -v
```

结果：**52/52 通过**。

干净 v0.3.1 补丁验收：

- 用 `git archive v0.3.1` 取得不含本机改动的发布源码；
- 应用 `integrations/dafeiyu-v0.3.1-arena-bridge/`；
- **14/14 Arena 测试通过**。

完整 `unittest discover` 的 148 项在本机运行中桌宠/多进程锁环境下出现过个别旧测试抖动（`cross_process_claim`、临时提醒锁、部分 gateway mock 未触发）；单独重跑 `test_cross_process_claim` 通过。未把该环境抖动计入 Arena 通过数，也未据此声称 148 项全通过。

## 2. 关键卡局复现

用模拟大肥鱼和真实棋谱关键局面构造：黑 `H8/I7/G9/J6`，白 `H7/I8/J9`，随后黑 `F10`。第 7 手后轮到白方大肥鱼，且黑方 `F10`、`K5` 都是一步成五点。

结果：

- 第 7 手后没有启动会抢锁的自动点评；
- 白方大肥鱼合法走 `K5`，棋局不暂停；
- 黑方 `F10` 自然成五，终局 `win/black`；
- 9 手全部保存，回放 10 个视图（初始 + 9 手）；
- 终局 Dafeiyu 请求 `role=player`、`seat=white`，事件摘要含真实 `F10`，没有 `undefined`；
- 全程没有 429/“另一局”错误暂停。

对应测试：`tests/dafeiyu-priority.test.mjs`。

## 3. 真实桥锁竞争与结构化落子

直接对本机真实大肥鱼桥/KVMem：

- 先发起玩家点评，250 ms 后请求白/黑座位落子；
- 落子约 **4.0 s** 返回，合法 JSON `{"move":"H8",...}`；
- 被抢占的点评返回 `comment_skipped`，未阻塞落子；
- 落子请求使用 `response_format: json_object`，模型返回单个 JSON 对象；Arena 严格解析后接受。

真实 Arena 对局（隔离数据）：

- 真人黑 `H8` 后，大肥鱼执白在约 **6.6 s** 返回 `H9`；
- 动作 `metrics`：attempts 1、elapsedMs 6532、moveMode `assisted`、failures 空；
- 手动问题回答从白方身份出发，回答中明确“本鲸当然执白”；
- 对局未暂停、无锁错误。
- 新版浏览器 UI 直接连接真实桌宠与真实 KVMem：观战问答返回“本鲸当然是在看黑方先手啦……”，聊天标记「观战回答」，无脚本错误（见 `real-v2-dafeiyu-chat.png`）。

## 4. DeepSeek 空内容卡局

一次真实对局中（黑方大肥鱼、白方 DeepSeek Flash），白方在第 4 手前连续 3 次返回空文本，Arena 以 `ai_invalid_move` 暂停，随后用户结束对局。

同一局面复现：

- `max_tokens=300`：`finish_reason=length`，300 completion tokens 全部消耗为 reasoning，正文 0 字；
- `max_tokens=1200`：正常返回 `{"move":"H6",...}`；
- `max_tokens=3000`：也正常，但更慢。

根因是 DeepSeek 默认思考模式把输出预算用在 `reasoning_content`，不是桌宠锁、断网或非法棋盘状态。Arena 已把默认单步初始预算提高到 16,384，并允许模型配置到 32,768；下一次同局面不会再因 300-token 预算空正文暂停。真实低强度 token 采样见第 13 节。

## 5. 错误分类

模拟桌宠分别返回：

| 情形 | 结果 |
| --- | --- |
| HTTP 429 / `player_busy` | `dafeiyu_busy`，连接仍为 connected，不误判断线 |
| 自由文本 / 非 JSON | `dafeiyu_output_invalid`，有限重试后暂停 |
| 合法 JSON 但占点 | `dafeiyu_invalid_move`，有限重试后暂停 |
| 响应正文超时 | `dafeiyu_timeout`，连接仍 connected |
| 后台自动点评失败 | 记录 `dafeiyu_comment` 错误，不暂停、不判掉线 |
| 离开/断开时迟到回答 | 回答被取消，不写入旧局聊天 |

## 5. 超时与取消

回归模拟服务先发响应头，再故意延迟正文：

- 普通模型客户端在 220 ms 超时设置下约 245 ms 结束，错误 `timeout`；
- 普通模型正文读取阶段主动取消约 118 ms，错误 `cancelled`；
- 大肥鱼客户端约 185/104 ms 分别验证超时和取消。

证明计时器覆盖完整响应体，而不是收到响应头就撤掉。

## 6. 三座位/私有信息/回放版本

三座位测试插件（`tests/fixtures/three-seat-game.mjs`）：

- 3 个座位 `sun/moon/star`，按顺序行动；
- 全 AI 对局 8–9 手自然结束；
- 私有目标格参与九格满盘结算：构造局面仅有 `moon` 达成私有目标，结果 `winnerSeat=moon`；
- 公开 API、SSE 首帧、导出均不含 `privateTargets`/`secretNote`/`SUN-SECRET`；
- 模型提示含自己的私有目标，不含另外两个座位；
- 用 `git archive` 版相同数据、把插件 `rulesVersion` 改为 `9.9.9` 后，旧局仍从保存的权威快照打开。

## 7. 历史迁移

本机原有 4 局真实记录在切到 v0.2.0 后：

- 仍全部出现在对局记录；
- 3 局 aborted、1 局 99 手 finished；
- 自动补建快照：100、14、8、8 个视图（初始 + 手数）；
- 旧 `black_win`/`aborted` 结果和标签保留，历史筛选按“有胜负/已中止”归类；
- 旧回放可打开，按 100 步、时间轴、上一手/下一手操作；
- 未出现 Key 或私有状态。

## 8. 浏览器 UI

```powershell
node scripts/ui-smoke.mjs
```

结果通过，共 7 个测试对局，22 张冒烟截图（另 3 张正式数据截图）。实际点击/验证：

- 桌游库、模型管理、快速试玩、落子、暂停、继续、结束；
- 对局记录、回放上一手/下一手、三座位回放；
- 大肥鱼观战问题、自动点评、语音开关、断开/重连；
- 大肥鱼棋手断开暂停、重连、重试、真实落子/公开想法；
- 全 AI 自动点评；
- 三座位测试插件在游戏库出现、3 个座位、9 个格子、终局、回放；
- 全 AI 快速推进时输入中文：组词期间 DOM 输入节点未被替换，焦点、值、光标保持；compositionend 后继续；
- 900 px、480 px 宽度无横向溢出；
- 浏览器无脚本异常。

截图：

- `data/ui-check/01-lobby.png`
- `data/ui-check/02-model-modal.png`
- `data/ui-check/03-models.png`
- `data/ui-check/04-match.png`
- `data/ui-check/05-paused.png`
- `data/ui-check/06-history.png`
- `data/ui-check/07-replay.png`
- `data/ui-check/08-dafeiyu-chat.png`
- `data/ui-check/09-dafeiyu-paused.png`
- `data/ui-check/10-dafeiyu-player.png`
- `data/ui-check/11-ime-composing.png`
- `data/ui-check/11-auto-comment.png`
- `data/ui-check/12-three-seat.png`
- `data/ui-check/13-three-replay.png`
- `data/ui-check/14-lobby-900.png`
- `data/ui-check/15-lobby-480.png`
- `data/ui-check/16-blokus-invalid-preview.png`
- `data/ui-check/16-blokus-preview.png`
- `data/ui-check/17-blokus-match.png`
- `data/ui-check/18-blokus-replay.png`
- `data/ui-check/19-blokus-900.png`
- `data/ui-check/20-blokus-480.png`
- `data/ui-check/final-blokus-live-lobby.png`（真实本机配置，两个正式桌游）
- `data/ui-check/21-reasoning-settings.png`（DeepSeek 低推理 / 32768 输出上限）
- `data/ui-check/final-lobby-v2.png`
- `data/ui-check/final-history-v2.png`
- `data/ui-check/final-replay-v2.png`
- `data/ui-check/real-v2-dafeiyu-chat.png`（真实桌宠 + 真实 KVMem + 新 UI）

## 9. 棋力固定局面

```powershell
node scripts/model-benchmark.mjs
```

真实 KVMem 结果：

| 方案 | 战术正确 | 合法 | 平均耗时 | 卡局 |
| --- | --- | --- | --- | --- |
| 内置机器人 | 4/4 | 4/4 | 4 ms | 0 |
| KVMem 纯模型 | 1/4 | 4/4 | 1432 ms | 0 |
| KVMem 规则辅助 | 4/4 | 4/4 | 3897 ms | 0 |

历史 J9 关键局面中，内置机器人选择 **J6**，与用户观察一致，并制造双杀。KVMem 纯模型在一步成五/必堵局面选择 E2（合法但非最优），规则辅助选择 E1；纯模型在双杀局面选择 G8，规则辅助选择 F10。报告保存在 `data/benchmarks/`（Git 忽略）。

## 10. 干净目录安装

- 发布源复制到含中文和空格的临时目录，排除 `data/`、`.git/`、日志和缓存；
- 源内公开检查：**73 个文件通过**；
- 从 `C:\Windows\System32` 工作目录、使用绝对路径启动；
- 默认生成 `data/`，端口 8899（`ARENA_PORT` 覆盖）；
- 新增模拟模型，连接测试 13 ms；
- 模拟模型（黑，规则辅助）对内置机器人（白）自然终局：10 手，`win`；
- 回放 11 个视图；
- 重启后同一回放仍为 11 个视图，历史 1 局；
- 导出不含 Key。
- 同一干净目录新增角斗士棋走法：双机器人 29 手结束，回放 30 个视图，最终分数和 21 块棋子目录均可读；
- 最终公开文件数为 73。

## 11. 大肥鱼补丁

- 干净 `v0.3.1` tag 应用 `runtime/routes.patch` 和三个桥文件；
- `tests/test_arena.py` 14/14 通过；
- 本机 release 与运行副本哈希一致；
- 运行健康：`arena_game:true`、`clients:0`；
- 真实桥：落子优先、点评让位、真实落子/问答、会话 leave 已验证。

## 12. 角斗士棋：双人对决

规则版本 `1.0.0`，官方规则依据 [Mattel Blokus Duo 说明](https://mattel.co.jp/wp-content/uploads/2022/07/blokus_duo.pdf)。坐标约定为列 A–N 从左到右、行 1–14 从上到下，起始点 E5/J10。

- 21 块：1 格 1 块、2 格 1 块、3 格 2 块、4 格 5 块、5 格 12 块；朝向按旋转/翻面去重并给出稳定 ID。
- 先手第一块覆盖 E5 或 J10，后手第一块覆盖另一个；之后必须与己方棋子角接触，不能与己方棋边接触，异色可贴边。
- 无合法摆法时服务端自动执行 `{type:"pass"}`，来源记为 `system`；另一方继续。双方都停或一方放完 21 块时结算。
- 计分：未放格每格 -1；全放 +15；最后一块是单格再 +5；同分平局。
- 服务端规则引擎统一校验真人、模型、大肥鱼和机器人动作。测试覆盖重复 clientActionId、终局后迟到动作和快照回放。

模型：

- 纯模型提示只含规则、结构化棋盘、双方剩余棋子、当前回合和动作格式；真实 KVMem 首手返回 `P5-09 → E5`，约 5.6 秒，合法。
- 规则辅助首手有 828 个合法摆法，展示 80 个候选；候选带 `candidateId`、`pieceId`、`orientation`、`anchor`、`cells`，并记录 `candidateInfo.total=828 / shown=80 / filter`。真实 KVMem 返回 `P1-01 → E5`，约 6.7 秒，`modelMeta.candidateInfo` 已落盘。
- 大肥鱼棋手真实走 `P1-01 → E5`，约 18.3 秒，并产生第一人称公开想法；没有额外修改 MP 桥代码。
- 大肥鱼观战真实问答返回“选 E5 或 J10 都行，反正第一块必须盖住其中一个起始点”，标记观战身份。真实观战自动点评请求结果为空文本，未产生聊天；模拟桌宠自动点评通过，未把空文本当成成功。

浏览器：

- 大厅出现「角斗士棋：双人对决」卡片、2 席和红/蓝方配置；首座内部 ID 仍为 `gold`，仅用于兼容旧快照，界面与棋子显示为红色。
- 真人选择 P5-09 可旋转/翻面；选择 P2 在 E6 显示红色虚线的非法预览并显示起始点错误；取消不会提交。选择 P1 在 E5 显示绿色合法预览，确认后落子；机器人回手。
- 双机器人完整局自然结束，回放打开 196 格历史棋盘，末手、跳过动作和最终分数明细可读；1440、900、480 宽度均无横向溢出。
- 五子棋回归：UI 冒烟仍能新建、落子、暂停/继续、历史、旧回放。
- 模型编辑弹窗实际显示并保存：DeepSeek Flash / 推理强度「低」/ 单步输出上限 32768；见 `21-reasoning-settings.png`。

## 13. DeepSeek 低强度推理 token 采样

配置：DeepSeek Flash，`reasoningEffort=low`，`maxOutputTokens=32768`，规则辅助，模型对内置机器人。为排除“输出上限截断后重试”对峰值的干扰，测试时把单步初始预算临时提高到 32768；正式配置中 DeepSeek 初始预算为 16384，超过后按 32768 上限重试。旧默认模型上限仍为 4800。

| 游戏 | 完成手数 | 模型手数 | 单步最高 completion | P95 | 中位数 | 最高手耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 自由五子棋 | 17 | 9 | **9,429** | 9,429 | 1,543 | 60.8 秒 |
| 角斗士棋 | 34 | 16 | **12,244** | 12,244 | 2,685 | 85.0 秒 |

峰值明细：

- 五子棋第 11 手 `G10`：completion **9,429**，其中 reasoning 9,422，finish `stop`；
- 角斗士棋第 3 手 `P5-02 → K6`：completion **12,244**，其中 reasoning 12,236，finish `stop`；
- 两局全部成功终局，无截断/空正文错误。

结论：

- “低强度”不是硬 token 上限；低强度仍可能产生上万 completion token 的推理；
- 原先 4,800 token 硬上限不足以保证完成；
- 当前正式配置选择 **32,768** 上限更稳妥；若按最高观测值给最低建议，至少 16,384，实际建议 32,768；
- token 上限只能减少截断，不能保证及时落子；仍需时间上限/快速重试/失败可见。
- 原始逐手数据保存在 `data/benchmarks/deepseek-flash-low-token-2026-11-17.json`（Git 忽略）。

## 14. 仍需人工/环境验收

- **真实音色**未人工听音；已验证文字进入 TTS 队列、按会话取消状态、日志中的合成/清理。听到的实际音质不属于自动验收。
- **长时间拔网线**未做；用真实 HTTP 断开、API 断开、超时和会话失效模拟；恢复路径已测。
- **两个不同真实云模型**的完整长局未跑；两个独立模型配置、Key 隔离和终局由模拟 OpenAI 服务验证；单个本机 KVMem 真实落子/评测已验证。
- **公开 v0.3.1 干净安装**只做了源码补丁 + 14 项测试，未在另一台机器上启动完整桌宠前端做人工联测；本机 v0.3.1 工作副本已真实联测。
- 真实桌宠/真实 KVMem 已通过新浏览器 UI 问题链路；真实音色仍未人工听音。
- 三座位插件只用于测试环境，不是第一版正式游戏。
- 模型仍可能给出合法但糟糕的棋；规则辅助不是多步搜索。
- 本机 Key 明文存放，仅适合单人本机。
