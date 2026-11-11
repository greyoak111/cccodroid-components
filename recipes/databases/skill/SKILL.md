---
name: databases
description: 本机 Valkey 键值库（cccodroid 组件）：初始化、启动、停止、看状态、跑 valkey-cli，数据持久化在 ~/.cccodroid/databases/。用户要在设备上起本地缓存/键值库、测试 Redis 兼容命令时使用。当前不含 PostgreSQL。
---

# 本机数据库：Valkey

本机装了 Valkey 9.1.3（Redis 兼容，Termux 官方包），带一个非交互入口 `ccdb`。只监听 `127.0.0.1`，不对外。

**当前版本只有 Valkey，没有 PostgreSQL。** 底座（devkit-2026.10.28）的 libicu 是 78.3，而仓库里的 postgresql 18.6 需要 libicu 79.1，两个 PostgreSQL 包都起不来；等工具包更新后再加。用户问 PostgreSQL 时照实说，不要用 MariaDB 或别的库冒充。

## 先自检

```sh
ccdb selftest
```

最后一行应为 `===== 总结 ===== valkey=9.1.3 start=PASS set=PASS get=PASS stop=PASS`，约 2 秒。它在 `$TMPDIR` 起一个随机端口的临时 Valkey，SET/GET 后停掉并删目录；不碰用户数据。

## 运行链路

```
ccdb（$PREFIX/bin/ccdb，本组件的 Python 包装）
  ├─ valkey-server  $PREFIX/bin/valkey-server（本组件，Termux 包）
  │    └─ 监听 127.0.0.1:6380，数据目录 ~/.cccodroid/databases/valkey
  ├─ valkey-cli     $PREFIX/bin/valkey-cli（本组件）
  └─ Python         底座（包装脚本，只用标准库）

数据：~/.cccodroid/databases/valkey（RDB 快照）
进程：ccdb start 起的是后台守护进程；App 退到后台/被系统回收时可能被杀
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `ccdb` | 本组件 | 命令不存在 |
| `valkey-server` / `valkey-cli` | 本组件（Termux main） | 包装明确报「找不到 X」 |
| Python | 底座 | 包装脚本起不来 |
| 数据目录 | 用户 home | 首次 `ccdb init` 自动创建 |
| PostgreSQL | **未提供** | 没有 `psql` 服务；见上，等工具包更新 |

## 常用

```sh
ccdb init                         # 建数据目录（只需一次）
ccdb start                        # 启动，等 PING 通
ccdb status                       # 端口、数据目录、版本、键数
ccdb cli set hello world          # 执行任意 valkey-cli 命令
ccdb cli get hello
ccdb cli keys '*'                 # 注意：大库不要在生产上这样扫
ccdb stop                         # 停止并保存快照
ccdb info                         # 连接串与状态
```

- 连接串：`valkey://127.0.0.1:6380`（脚本里用 `redis://127.0.0.1:6380` 也可以，Valkey 兼容 Redis 协议）。
- 端口可用 `CCDB_VALKEY_PORT` 改；数据目录可用 `CCDB_HOME` 改。改之前先 `ccdb stop`。
- **一次对话里用完就停**：`ccdb start` 起的进程在 App 退后台后不保证活着；不要假设它常驻。
- 数据在 `~/.cccodroid/databases/valkey`；删目录等于清库，删前问用户。
- `ccdb stop` 会触发保存；直接杀进程可能丢最近的写入。

## 常见坑

- **只绑 127.0.0.1，没有密码**：不要改成 `0.0.0.0`，也不要把端口转发到公网。要远程访问就用 SSH 隧道，别把无认证的库暴露出去。
- **不是 PostgreSQL**：没有 SQL、没有 `psql`、没有 pgcli。需要 SQL 的用户先看 `sqlite`（底座自带）或等 PostgreSQL 版本；不要用 Valkey 存关系型数据。
- **App 后台回收**：长时间任务里如果连接突然断开，先 `ccdb status` 看进程还在不在；不在就重新 `ccdb start`，数据不会丢（stop/正常退出时已保存）。
- **并发写**：Valkey 是单线程命令处理，适合缓存/队列小数据；不要把大文件塞进去。
- **`ccdb cli` 不带参数会进交互模式**：在 Claude 的 Bash 里没有 TTY，务必带完整命令（如 `ccdb cli get key`），不要留交互。
