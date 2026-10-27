# QQ 频道（协议层草稿）

把 QQ 官方机器人接成 cccodroid 的频道：私聊、群聊里 @ 机器人，消息进 cccodroid 的会话，回答再发回 QQ。

**这份代码暂时不是可安装的组件**：目录里没有 `recipe.json`，`cccodroid-components` 的构建与 CI 会跳过它。原因在下面「缺什么」一节。

## 目录

```
recipes/qq-channel/
  lib/qq.mjs       协议纯函数：事件归一化、markdown 归一、分段、发送载荷、扫码绑定解密
  lib/client.mjs   传输层：换令牌 → 网关 → Identify / Resume → 心跳、重连；发消息、发文件
  test/            node:test，离线，假的 fetch / WebSocket
```

`qq.mjs` 不联网、不读文件；`client.mjs` 的 `fetch`、`WebSocket`、`now` 都从 `deps` 注入，测试里全用假的顶替。

```sh
node --test recipes/qq-channel/test/*.test.mjs
```

## 协议上踩过的坑

这些细节写死在代码里，改动前先看一眼：

- **markdown**：正文要放进 `markdown.content`（`msg_type: 2` 的对象），放 `content` 里客户端只显示原始的 `**` 和 `#`。代码块围栏要用 `~~~`，反引号 ``` 渲染是乱的；表格不支持，竖线要换掉。
- **被动回复**：带 `msg_id` 的回执只在收到消息后 5 分钟内有效、同一个 `msg_id` 最多回 5 条，`msg_seq` 必须从 1 逐条加一。跑得久就会过期，过期后改发主动消息（需要机器人有主动消息权限）。
- **引用**：`message_reference` 只在非 markdown 模式下认；入站事件的引用只给一个 `ref_msg_idx`，要配 `msg_elements` 才能拿到被引用的正文。
- **富媒体**：先 `POST /files` 拿 `file_info`，再发 `msg_type: 7` 的消息；只有「文件」类型（4）认 `file_name`。
- **intents**：只订 `GROUP_AND_C2C_EVENT`（`1 << 25`），别的都是私域/频道消息，用不上。
- **重连**：`op 7` 要求重连、`op 9` 会话失效（重新 Identify），有心跳回音超时检查；退避是 1/2/5/10/20/30 秒。

## 安全

- AppSecret 只从调用方传进来的 `cfg` 读，不落盘、不进日志；`probe()` 只回令牌前 6 位。
- 扫码绑定的 `bot_encrypt_secret` 用本机随机 32 字节的 key 做 AES-256-GCM 解密，key 不离开本机。
- 消息里带的图片/文件是 CDN 直链，是否下载、下到哪由调用方决定。群聊里任何人都能 @ 机器人，接进会话时应当只给受限的权限模式。

## 缺什么：为什么先不开 `recipe.json`

组件仓库现在的 recipe 只有 `termux` / `glibc` 两种安装型，没有「随网关常驻的进程、自启、设置页里的入口」这层机制。频道需要的东西正好在这层：

1. **常驻**：QQ 是 WebSocket 长连接，得跟着网关起停，而不是装完就退出。
2. **配置入口**：AppID / AppSecret、扫码绑定、开关，要有一页 UI，以及存在哪里的约定。
3. **会话参数**：从外部消息起的会话需要 `unattended`（没人看着也不能停等确认）、`disallowedTools`（默认不给危险工具）、`finalText`（只把最后一段回答发回去）。现在 `/api/chat` 会把这些字段从非 `internal` 请求里剥掉，组件拿不到。
4. **归档**：每个 QQ 会话对应一个 cccodroid 会话，需要有稳定的映射和清理。

核心加上这些之后，这里补 `recipe.json`、`skill/SKILL.md` 和设置页入口就能装。
