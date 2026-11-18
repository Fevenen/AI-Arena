# 来源说明

本项目源代码、网页视觉、内置五子棋/角斗士棋启发式机器人和棋盘绘制均为 AI Arena 项目原创。Blokus / Blokus Duo 是 Mattel 的商标；本项目只按公开官方规则实现玩法，不包含官方棋子、棋盘图片或素材。

运行时：

- Node.js 标准库，无第三方 npm 包。
- 浏览器端无第三方框架、字体、图片 CDN 或统计脚本。
- 角斗士棋规则依据 Mattel 官方 Blokus Duo 说明：<https://mattel.co.jp/wp-content/uploads/2022/07/blokus_duo.pdf>。

可选协作项目：

- **大肥鱼 (Dafeiyu)** 是独立维护的 Windows 桌宠项目，拥有自己的 MIT 许可证、角色配置、模型配置和运行数据。竞技场不包含其素材或权重。双方只通过本机 HTTP 接口交换公开棋局信息。
- 可选兼容补丁位于 `integrations/dafeiyu-v0.3.1-arena-bridge/`，其中大肥鱼桥文件派生自 Dafeiyu，版权归 Dafeiyu contributors，按 MIT 使用；具体文件、安装与联测边界见 `docs/dafeiyu.md` 和补丁目录 README。

模型服务：

- 本项目只实现通用 OpenAI Chat Completions 兼容客户端；具体模型、供应商、服务条款和数据处理方式由用户自行配置并负责。

## Splendor

The classic Splendor rules and game names are from Space Cowboys. The implementation uses numeric card facts, no official graphics, with the source recorded in the card catalog.
