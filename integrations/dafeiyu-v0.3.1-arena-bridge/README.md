# 大肥鱼 v0.3.1 · AI Arena 桥接补丁

这是给 **大肥鱼桌宠 v0.3.1** 使用的可选补丁。AI Arena 本身不依赖它：没有桌宠时，内置机器人、普通模型、回放和历史仍可独立工作。

## 兼容性

- 目标上游：大肥鱼公开标签 **v0.3.1**（`bridge_version` 为 `0.3.1`）。
- 已验证环境：本项目本机的 Dafeiyu v0.3.1 发布源码和已安装运行副本；运行副本的健康版本可能显示安装时的 `0.2.1`，只要路由文件是同一套 v0.3.1 runtime 结构即可。
- 另用 `git archive v0.3.1` 的干净源码应用本补丁，14 项 Arena 桥测试全部通过；不是只验证了本机已改过的工作树。
- 上游 v0.3.1 **没有** Arena 桥。只安装 v0.3.1 时，`/api/game/arena/*` 不存在，AI Arena 会提示“没有竞技场接口”。
- 本补丁包含：Arena 路由、游戏模型调度/身份提示、按会话取消语音，以及 `routes.py` 两处接线。
- 未修改大肥鱼的聊天、QQ、提醒、屏幕、酒馆、角色卡或 TTS 配置。

## 安装

在 **大肥鱼 v0.3.1 发布源码根目录** 执行（路径按你的实际位置替换）：

```powershell
$patchRoot = "D:\path\to\AI-Arena\integrations\dafeiyu-v0.3.1-arena-bridge"
Copy-Item "$patchRoot\bridge\arena_routes.py" ".\bridge\arena_routes.py" -Force
Copy-Item "$patchRoot\bridge\games\arena.py" ".\bridge\games\arena.py" -Force
Copy-Item "$patchRoot\bridge\presentation.py" ".\bridge\presentation.py" -Force
git apply "$patchRoot\runtime\routes.patch"
```

如果安装包不是 Git 工作树，按 `runtime/routes.patch` 手动做三处修改：

1. 在 `init_client_ws_route` 中导入并挂载 `arena_router`；
2. 挂载 `router.include_router(arena_router(ws_handler))`；
3. 在 `/api/health` 返回值加入 `"arena_game": arena_enabled()`。

已安装运行副本的实际路由文件通常位于：

```text
<大肥鱼运行目录>/src/open_llm_vtuber/routes.py
```

发布源码位于：

```text
<大肥鱼源码目录>/runtime/open_llm_vtuber/routes.py
```

两种位置做同样的两处导入/挂载和 health 字段修改。

然后重启大肥鱼后端和桌宠窗口。健康检查应类似：

```text
GET http://127.0.0.1:12393/api/health
{"ok":true,"bridge_version":"0.3.1","arena_game":true,"clients":0}
```

`clients` 为 0 时文字仍可用，但语音会显示 `no_client`；要听语音，需要打开桌宠窗口并保持连接。

## 配置

`bridge/config.json` 可选：

```json
{
  "arena_enabled": true,
  "arena_origins": "http://127.0.0.1:8787",
  "arena_token": ""
}
```

- `arena_origins` 留空时只接受 Loopback Origin；生产单机建议显式写 Arena 地址。
- `arena_token` 非空时，Arena 的 `dafeiyu` 配置也要填同一令牌。
- 游戏模型沿用现有 `kvmem_upstream` / `kvmem_model`；不会走现实命令工具。

## 联测

1. 打开 AI Arena，在桌宠面板点「检测」，看到「桌宠在线」。
2. 开一局，邀请大肥鱼观战，手动问一句；应显示「观战回答」。
3. 把一席改成「大肥鱼 · 桌宠棋手」，确认她能落子；棋局落子优先于自动点评。
4. 关闭语音，确认等待中的旧播报被取消（需要已连接桌宠窗口时才有真实音频队列）。
5. 结束或离开页面，再开新局；旧会话应已释放，不应撞到 8 个会话上限。

## 离线测试

把本目录 `tests/test_arena.py` 复制到大肥鱼源码的 `tests/`，然后：

```powershell
$env:PYTHONPATH = "<大肥鱼源码目录>"
& "<桌宠 Python>" -m unittest tests.test_arena -v
```

本补丁测试数：14 项。

## 许可

本补丁中的大肥鱼桥文件派生自 Dafeiyu 项目，按 Dafeiyu 的 MIT License 使用；版权归 Dafeiyu contributors。AI Arena 自身使用 MIT License。不要在本目录放角色卡、模型权重、API Key 或个人配置。
