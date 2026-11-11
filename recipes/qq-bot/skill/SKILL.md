---
name: qq-bot
description: 在 cccodroid 上原生运行 Linux QQ + NapCat 的 OneBot 机器人：首次安装、扫码登录、白名单、模型后端与排错。用户要部署/维护 QQ 机器人时使用。
---

# QQ 机器人（原生 NapCat）

在手机上**原生**跑 Linux 版 QQ + NapCat，不使用 proot、不需要 root。QQ 跑在组件自带的
Xvfb 虚拟显示里，NapCat 注入后提供 OneBot v11，本组件附一个只应答白名单会话的桥。
所有运行数据在 `~/.cccodroid/qq-bot`（`$HOME` 下），不写系统分区。

## 先问用户，再下载

`qq-bot setup --check` 只报体积，不下载。把下面这些告诉用户，得到明确同意后再加 `--yes`：

- Debian trixie 运行库（GTK3/NSS/ALSA/GBM 等）：约 74 MB 下载 / 334 MB 解开
- Linux QQ 3.2.34（腾讯官方 CDN）：198 MB 下载 / 646 MB 解开
- NapCat 4.18.42（GitHub Release）：34 MB 下载 / 约 112 MB 解开
- 合计约 307 MB 下载、1.1 GB 占用；安装时间取决于网速，可能十几分钟

来源、版本、SHA256 都写在组件的 `NOTICE` 里；安装器逐个核对。QQ 是腾讯的闭源客户端，
NapCat 是上游的受限再分发许可，两者都不随组件包分发，只在用户确认后下载。

## 安装与登录

1. `qq-bot setup --yes`（用户同意后）。可加 `--jobs 4`。失败重跑会续用缓存。
2. `qq-bot start`。它会起 Xvfb、X 代理、QQ、NapCat 和桥；输出扫码地址。
3. 让用户在应用内浏览器打开 `http://127.0.0.1:8787/` 扫码（端口占用时看
   `qq-bot status` 的实际端口）。二维码 60–90 秒过期，扫完要在手机上立刻点「确认登录」。
4. `qq-bot status` 或 `qq-bot whoami` 直到显示已登录。没登录时 OneBot 的 3000/3001
   不会监听，这是正常的。
5. 放行会话：`qq-bot allow add <用户自己的 QQ 号>`。群聊用
   `qq-bot allow add-group <群号>`；默认只在有人 **@ 机器人** 时回复。

白名单默认为空，空的时候不响应任何人。不要为了“先跑起来”把 `groupTrigger` 改成 `any`，
也不要把机器人拉进用户没有明确同意的群。

## 模型后端

桥走 OpenAI 兼容的 `/chat/completions`。默认是 DeepSeek：

```
qq-bot config set backend.baseUrl https://api.deepseek.com/v1
qq-bot config set backend.model deepseek-chat
```

用户可以换成任何 OpenAI 兼容服务（包括本机的 llama-server）。只允许 https，或
`http://127.0.0.1`/`localhost`；不要把带密钥的明文 http 指到外网。

密钥：**绝不要让用户把密钥贴进对话，也不要读取或打印它**。让用户自己在终端里创建：

```
printf '%s' '你的密钥' > ~/.cccodroid/qq-bot/model-key.txt
chmod 600 ~/.cccodroid/qq-bot/model-key.txt
```

路径可以用 `qq-bot config set backend.apiKeyFile <路径>` 改；`qq-bot config` 会打码。
没配置密钥时桥会重试并在 `bridge.log` 记一条（每分钟最多一条），不会把密钥写进日志。

## 与原教程的差异

原始教程（DSHA + proot Ubuntu）用 NapCat + qq-bridge + DSH 内核。这里保留前半段并在
原生环境重做，后半段换了：

- **不装 proot、不装 Ubuntu**：QQ 直接跑在安卓上，用 Debian 的 GTK3 闭包 + 本机 glibc，
  Xvfb 用 Termux x11 仓库的 bionic 版，外面加一个回环 TCP→Unix 代理。
- **不用 qq-bridge**：上游已宣布 2026-11-18 归档，且它的当前版本依赖 SnowLuma 与 DSH，
  cccodroid 没有这些。组件自带一个只做 OneBot ↔ OpenAI 兼容接口的桥，功能收窄为
  白名单会话问答，不做人格仿真、主动发言或群友模拟。
- **不用 DSH_WEB_URL**：模型地址由 `qq-bot config set backend.baseUrl ...` 指定。

## 身份与使用边界

- 系统提示默认明确要求“被问到身份时说明是 AI、不假装人类、不主动发起话题”。
  不要把它改成仿真真人、模拟群友、主动搭话的人格。
- 只做单账号的个人助手；不帮助批量注册/养号/刷评论/冒充真人/未经邀请的群发。
- 使用非官方客户端/NapCat 有账号被限制的风险，如实告诉用户；不要把“绕过风控”
  当作配置项。
- 扫码登录必须在腾讯客户端里由用户完成。不要索取账号密码、验证码或登录凭据。

## 运行链路（动手前先读，别猜）

`qq-bot start` 不是直接跑 QQ，它起一层 supervisor，把下面几段接起来：

```
qq-bot（Node，$PREFIX/bin/qq-bot）
  └─ supervisor.mjs（Node，bionic）
       ├─ $PREFIX/bin/Xvfb :99（bionic，x11 仓库）—— 虚拟 X 显示
       ├─ X 代理 127.0.0.1:6099（Node）→ $PREFIX 下的 tmp/.X11-unix/X99
       ├─ QQ（glibc，debroot/opt/QQ/qq，解释器已改成 $PREFIX/glibc/lib/ld-linux-aarch64.so.1）
       │    └─ NapCat 注入（loadNapCat.js → app_launcher/napcat/napcat.mjs）
       │         └─ OneBot HTTP/WS 127.0.0.1:3000 / 3001
       ├─ bridge.mjs（Node，bionic）—— OneBot → OpenAI 兼容接口
       └─ 扫码页 http://127.0.0.1:8787/（读 NapCat 的 cache/qrcode.png）
```

| 这一环 | 由谁提供 | 在哪 |
|---|---|---|
| CLI、supervisor、桥、扫码页 | 本组件脚本 | `$PREFIX/share/cccodroid/components/qq-bot/lib/` |
| Xvfb 与 X 工具 | Termux x11 仓库（组件依赖） | `$PREFIX/bin/Xvfb`、`$PREFIX` 下的 `tmp/.X11-unix/` |
| GTK3 / NSS / ALSA / GBM 等 | `qq-bot setup` 从 Debian trixie arm64 取 | `~/.cccodroid/qq-bot/data/debroot/` |
| QQ 本体 | `qq-bot setup` 从腾讯官方 CDN 取（198 MB，核 SHA256） | `debroot/opt/QQ/` |
| NapCat | `qq-bot setup` 从 GitHub Release 取（34 MB，核 SHA256） | `debroot/opt/QQ/resources/app/app_launcher/napcat/` |
| glibc 运行时 | base 的 glibc 包；Debian 的 libc6 故意跳过 | `$PREFIX/glibc/lib/` |

几条由此而来的事实：

- **debroot 不是系统根**：Debian 的 GTK/NSS 库还在找系统根下的 `/usr/...` 和 X11 套接字目录。
  supervisor 用 `FONTCONFIG_FILE`、`GSETTINGS_SCHEMA_DIR`、`GDK_PIXBUF_MODULE_FILE`
  等把它重定向到 debroot；X 显示则用**只监听 127.0.0.1 的 TCP 代理**接进
  `$PREFIX` 下的 `tmp/.X11-unix`，因为 Debian 的 libxcb 写死了系统临时目录，而安卓的根级临时目录不可写。
- **QQ 必须用改过解释器的二进制**：`patchelf --set-interpreter` 把它指到
  `$PREFIX/glibc/lib/ld-linux-aarch64.so.1`。若用 `ld.so --library-path ... qq` 启动，
  `/proc/self/exe` 会指向加载器，Chromium 找不到 `icudtl.dat`，报
  `Invalid file descriptor to ICU data received` 后退出。
- **库路径只能是 debroot 的库目录 + `$PREFIX/glibc/lib`**，绝不能有 `$PREFIX/lib`
  （bionic 的 libc，混进去会满屏 `version 'LIBC' not found`）。supervisor 只在
  QQ 子进程里设 `LD_LIBRARY_PATH`，不污染自己的 Node/系统工具。
- **登录前 OneBot 不监听**：NapCat 要等 QQ 登录成功才打开 3000/3001；扫码页读的是
  `cache/qrcode.png`，不依赖 OneBot。`qq-bot status` 显示“等待扫码登录”是正常的。
- **模型后端在桥里，不在 DSH 里**：不要去找 `DSH_WEB_URL` 或 qq-bridge；本组件用
  OpenAI 兼容接口，配置见 `qq-bot config`。QQ ↔ NapCat ↔ bridge 之间只走
  `127.0.0.1`。

确认走的是哪条路：

```sh
qq-bot status                 # supervisor / QQ / 桥 / 登录状态 / 扫码端口
qq-bot doctor                 # 安装、密钥权限、3000/3001、扫码页
readelf -l ~/.cccodroid/qq-bot/data/debroot/opt/QQ/qq | grep -A1 INTERP
# 应指向 $PREFIX/glibc/lib/ld-linux-aarch64.so.1
ps -ef | grep -E 'Xvfb :99|/opt/QQ/qq|bridge.mjs'
```

## 排查

- **QQ 起不来/没有二维码**：`qq-bot logs 120`（先问用户，日志可能含聊天内容）。
  看 `qq.log` 是否有 `GPU process launch failed`。启动参数已固定为
  `--no-sandbox --disable-dev-shm-usage --disable-gpu`，不要加
  `--in-process-gpu`、`--single-process`、`--disable-gpu-compositing`。
- **反复崩**：`qq-bot stop`，删掉
  `~/.cccodroid/qq-bot/data/home/.config/QQ/Crashpad` 和 `crash_files` 里的内容
  （不要删整个 `.config/QQ`，那会丢登录态），再 `qq-bot start`。
- **扫码后很快又回二维码**：确认这个 QQ 没有在别的设备登录；等 10 分钟风控冷却。
- **OneBot 连不上**：先确认已登录；`qq-bot status` 看 3000/3001。`qq-bot doctor`
  会检查安装、密钥权限、端口。
- **模型报错**：`bridge.log` 里有 HTTP 状态和响应片段；不要打印密钥。检查
  `baseUrl` 是否包含 `/v1`、模型名是否存在、余额是否足够。
- **端口占用**：OneBot 3000/3001、扫码页 8787–8789、WebUI 已关闭。用
  `qq-bot doctor` 看是哪一项。

## 数据与卸载

- 登录态/缓存：`~/.cccodroid/qq-bot/data/home/.config/QQ`
- 配置：`~/.cccodroid/qq-bot/config.json`；密钥：同目录 `model-key.txt`
- NapCat 配置：`~/.cccodroid/qq-bot/data/debroot/opt/QQ/resources/app/app_launcher/napcat/config`
- 日志：`~/.cccodroid/qq-bot/logs`
- 卸载组件不会自动删这些数据。要彻底删除，先 `qq-bot stop`，再让用户确认后删
  `~/.cccodroid/qq-bot`（会丢登录态和配置）。
- 不要把 `config.json`、`model-key.txt`、`onebot11*.json` 或登录态拷到共享存储/仓库。
