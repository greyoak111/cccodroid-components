---
name: bilibili-mcp
description: B 站 MCP（bilibili-mcp，cccodroid 组件）：读 B 站视频信息、简介、章节、评论、字幕，搜视频和 UP 主，看收藏夹。用户给了 B 站链接 / BV 号，或要找、总结 B 站视频时使用。
---

# B 站 MCP（bilibili-mcp）

上游：<https://github.com/XZXZZX-Ai/bilibili-mcp>（npm 包 `@xzxzzx/bilibili-mcp`，Apache-2.0）。
组件装好后 App 已经用 `claude mcp add` 把它注册成 MCP 服务 **bilibili**，工具名形如 `mcp__bilibili__get_video_info`。
**只读**：不发评论、不点赞、不投币、不收藏。

## 运行链路

```
Claude Code ──stdio──> $PREFIX/bin/bilibili-mcp（包装脚本）
                         └─ node $PREFIX/lib/bilibili-mcp/node_modules/@xzxzzx/bilibili-mcp/dist/cli.js
                              ├─ 凭据  ~/.bilibili-mcp/config.json   ← 用户自己 bilibili-mcp setup 写进去
                              └─ 网络  直连 api.bilibili.com 等（https）
```

- 工具列表里没有 `mcp__bilibili__*`：先 `claude mcp list` 看有没有 bilibili 这一项。没有就是没注册上，
  请用户在 扩展 → 组件 里重装本组件（或在扩展页的 MCP 里手动加：命令填 `bilibili-mcp`）。注册后要**新开会话**才生效。
- 有这一项但连不上：在终端跑 `bilibili-mcp doctor --json` 看本机状态（不含秘密）。
- 上游 README 里的 `npx -y @xzxzzx/bilibili-mcp@latest …` 在这里一律换成 `bilibili-mcp …`：本组件钉了版本，不要另用 npx 拉最新版。

## 登录：只能用户自己来

不登录能查单个视频的信息、简介、章节、评论；**字幕、搜索视频、搜 UP 主、收藏夹、UP 主作品列表都要登录**（实测未登录时字幕返回凭据过期 / 未登录）。

- 先调 `check_bilibili_credentials`：`configured: true` 且 `logged_in: true` 才算登好了。
- 没登录：请用户打开 cccodroid 的**终端**，运行 `bilibili-mcp setup`，回车选扫码登录，用手机 B 站 App 扫终端里的二维码并在手机上确认。
  问到是否安装本地 ASR 模型时**选否**（见下）。登完新开会话再用。
- 本机就是那台手机、没法扫自己屏幕时：在登录方式里选「手动 Cookie」，按上游 `docs/client-setup.md` 从浏览器取字段，在终端的隐藏提示符里输入。
- **不要索要、读取、打印或转述 Cookie / SESSDATA / bili_jct**，也不要读 `~/.bilibili-mcp/config.json`。

## 常用

| 想做的事 | 工具 |
|---|---|
| 视频标题、UP 主、时长、简介 | `get_video_metadata` / `get_video_info` |
| 分 P、章节 | `get_video_chapters` |
| 字幕（带时间戳，可按区间、关键词筛） | `get_video_transcript`（要登录） |
| 评论 | `get_video_comments` |
| 按主题搜视频 / 按名字找 UP 主 | `search_bilibili_videos` / `search_bilibili_creators`（要登录） |
| 收藏夹 | `list_bilibili_favorite_videos`（要登录；每次一页 20 条，跟着 `next_cursor` 继续） |
| UP 主的投稿 | `get_bilibili_creator_content`（要登录） |

参数接受 BV 号或完整链接。

## 注意

- **本地 ASR 在这里用不了**：上游的无字幕转录靠 faster-whisper（Python + CTranslate2），安卓上没有现成的。
  视频没字幕时如实告诉用户，别把 `fallback_to_asr` 设为 true。
- 要把视频内容整理成文字：先拿字幕，没有字幕就只用简介、章节和评论，并说明信息来源有限。
- `check_mcp_update` 报有新版时不要自行升级，告诉用户等组件更新。
