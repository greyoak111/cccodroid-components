---
name: minecraft-server
description: 在 cccodroid 上原生开 Minecraft Java 版服务器（Paper 1.21.11）：初始化、EULA、启动/停止、控制台、白名单、世界备份和排错。用户要开 MC 服、和朋友联机或管理服务器时使用。
---

# Minecraft 服务端（Paper）

在手机上原生跑 Minecraft Java 版服务端，不需要 root、proot 或电脑。Paper 1.21.11-132
跑在底座自带的 Java 21 上，默认只监听 `127.0.0.1:25565`；本机的 Java 客户端（需要自己的 Minecraft 账号）可以直连，局域网里的电脑/手机客户端连这台手机的 IP。所有世界、配置、日志和备份在
`~/.cccodroid/minecraft-server`，不写系统分区。

## 先问用户，再初始化

`minecraft-server setup --check` 只读，不写文件。把下面这些告诉用户：

- Paper 1.21.11-132 已随组件安装，约 52 MB，GPL-3.0。
- **第一次 `start` 会由 Paper 从 Mojang 官方下载 Minecraft 1.21.11 原版服务端（约 54 MB），
  再在本地打补丁。** 这台机器实测首次约 9 分钟，之后启动约 13 秒；需要联网。
- 跑服务端要接受 Minecraft EULA：<https://aka.ms/MinecraftEULA>。**让用户自己读、自己明确同意**；
  不要替用户判断“应该没问题”。得到同意后，才执行：

  ```sh
  minecraft-server setup --accept-eula
  ```

  可选参数：`--lan`（监听局域网，默认只监听本机）、`--port 25566`、`--whitelist`、
  `--memory 2G`。这些只在第一次创建 `server.properties` 时生效；已有配置不会被覆盖。

## 启动与连接

```sh
minecraft-server start            # 后台启动，默认等 60 秒
minecraft-server status           # 进程、地址、运行时间、最后一行日志
```

首次启动 60 秒内通常还没打完补丁，`start` 会先返回并提示“仍在后台运行”。**不要重复 start**；
用 `status` 或 `logs` 等。想一次等到就绪可以用 `start --wait 600`（最多 900 秒）。

- 本机 Java 客户端（需要自己的 Minecraft 账号）：直接连接 → `127.0.0.1:25565`。
- 局域网：`minecraft-server config set bind lan`（先 stop），再 `start`；朋友连这台手机的
  IP:25565。只在可信局域网这样做，并保持 `online-mode=true`；建议同时
  `minecraft-server whitelist on`，再 `whitelist add <玩家名>`。
- 不要把 25565 直接暴露到公网，也不要用隧道/反代把它公开；Minecraft 本身没有额外的
  登录层，公开端口等于把服务器交给扫描器。组件不提供 offline-mode/破解客户端支持。

## 运行链路

```
minecraft-server（$PREFIX/bin 的 sh 包装）
  └─ $PREFIX/bin/python3 .../lib/cli.py
       └─ supervisor.py（detached，去掉了 CCAPP_RUN 等运行标记，不随这一轮对话停止而退出；数据目录的 run/state.json 记录 pid）
            ├─ java -Xms512M -Xmx2G -XX:+UseG1GC -jar paper.jar nogui
            │    ├─ 首次启动：Paperclip 从 Mojang 下载原版服务端到 cache/，再打补丁
            │    └─ 监听 server.properties 里的 server-ip:server-port（默认 127.0.0.1:25565）
            ├─ run/control.sock：console / stop / backup 的控制通道
            └─ logs/server.log：Java 的 stdout/stderr
```

| 这一环 | 由谁提供 | 装在哪 / 缺了会怎样 |
|---|---|---|
| `minecraft-server` 包装、CLI、supervisor、selftest | 本组件 | `$PREFIX/share/cccodroid/components/minecraft-server/`；缺了命令不存在 |
| `java` 21、`python3`、`jar` | 底座（`openjdk-21`、`python`） | 底座包；缺 Java 会明确报“Java 太旧/找不到” |
| `paper.jar` 1.21.11-132 | 本组件通过 `fetch` 从 PaperMC 官方取 | `$PREFIX/share/cccodroid/components/minecraft-server/paper.jar`；哈希不对会报组件安装不完整 |
| Minecraft 原版服务端 jar | **不在组件里**；Paper 首次启动从 Mojang 官方下载 | `~/.cccodroid/minecraft-server/cache/`；没网/下载失败时启动停在日志里 |
| 世界、server.properties、白名单、备份 | 本组件在数据目录生成 | `~/.cccodroid/minecraft-server/`；删除前必须问用户 |

降级路径：没有。Paper 起不来就没有服务器；如果只是 `JNA`/`OSHI` 的
`NoClassDefFoundError` 警告，但日志随后出现 `Done (`，服务器仍是好的（这是 Android 上
读硬件信息失败，Paper 自己忽略了）。

## 控制台、白名单、备份

```sh
minecraft-server console list
minecraft-server console say 服务器五分钟后重启
minecraft-server console op 玩家名
minecraft-server whitelist on
minecraft-server whitelist add 玩家名
minecraft-server whitelist list
minecraft-server backup
```

`console`/`whitelist` 的输出会写到 `logs/server.log`，CLI 只回显末尾几行；完整输出看
`minecraft-server logs`。`backup` 在服务器运行时先发 `save-off`、`save-all flush`，等 3 秒再
打包 `world*` 和配置到 `backups/world-<时间>.tar.gz`，最后恢复 `save-on`；服务停止时直接打包。
备份里有玩家数据和聊天记录，按用户私有文件对待。

## 配置

```sh
minecraft-server config
minecraft-server config set memory 3G        # 下次 start 生效
minecraft-server config set port 25566       # 先 stop
minecraft-server config set bind loopback    # 先 stop；只监听本机
minecraft-server config set bind lan         # 先 stop；监听所有网卡
minecraft-server config set whitelist on     # 先 stop；下次 start 生效
```

内存默认 2G，范围 512M–8G。改 `server.properties` 里的 `view-distance`、
`simulation-distance`、`max-players` 也能省资源；改之前先 `stop`。

## 停止与数据

```sh
minecraft-server stop
minecraft-server logs 120
```

`stop` 先向服务器发 `stop`，等它存档退出；90 秒没退出才终止 Java。**不要直接杀 Java 进程**，
否则可能丢最近一段世界数据。数据目录：

- 世界：`~/.cccodroid/minecraft-server/world*`
- 配置：`server.properties`、`eula.txt`、`config.json`
- 日志：`logs/server.log`
- 备份：`backups/`
- 首次下载缓存：`cache/`

卸载组件不会自动删数据。要彻底删除，先 `stop`，再让用户确认后删
`~/.cccodroid/minecraft-server`（会丢世界、白名单和备份）。不要把世界、日志或备份
拷到共享存储/仓库。

## 常见坑

- **EULA 没接受**：`start` 会拒绝。让用户读 <https://aka.ms/MinecraftEULA>，同意后
  `setup --accept-eula`；不要手动写 `eula=true` 绕过。
- **首次启动很慢/没有端口**：Paper 在下载原版 jar 并 remap，第一次 5–15 分钟正常。
  看 `logs 80`，等 `Done (`；不要重复执行 `start`。
- **端口被占**：日志里是 `FAILED TO BIND TO PORT`。先 `stop`，再
  `config set port 25566`；Minecraft 客户端也要改端口。
- **内存不够/卡顿**：`config set memory 3G` 后 `restart`；同时把 `view-distance` 降到 4–6。
  不要超过 8G，手机还要留给系统和 App。
- **`status` 说状态文件是旧的**：`minecraft-server stop` 清理后重新 `start`。
- **白名单没生效**：`whitelist on` 后要确认 `server.properties` 里是 `white-list=true`；`whitelist add` 的名字是
  Minecraft 用户名（3–16 位字母/数字/下划线），不是 QQ 昵称。
- **Paper 最新版 26.3 要 Java 25**：组件锁 1.21.11-132，因为底座是 Java 21；不要直接换
  Paper jar，除非先把 Java 25 和兼容性一起解决。
- **后台被冻结**：Android 可能在 App 退到后台后冻结进程。联机时保持 cccodroid 在前台；
  如果锁屏后端口不通，先 `status`/`logs`，不要反复重启。

## 自检

```sh
minecraft-server selftest
```

最后一行应为：

```
===== 总结 ===== java=OK paper=OK paperclip=OK properties=OK
```

它不联网、不启动世界，只检查 Java 版本、Paper jar 的 sha256、Paperclip 入口和
`server.properties` 解析。
