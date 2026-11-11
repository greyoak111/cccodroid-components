---
name: backup
description: 加密增量备份与同步（restic + age + rsync，cccodroid 组件）：把目录备份到本地/SFTP/S3，校验仓库、恢复文件、清理旧快照；用 age 加密单个文件，用 rsync 做本地或 SSH 同步。用户提到备份、恢复、快照、加密文件、同步目录时使用。
---

# 备份与同步：restic + age + rsync

本机装了 restic 0.19.1、age 1.3.2、rsync 3.5.2（都是 Termux 官方包），外加包装命令 `ccbackup`。

## 先自检

```sh
ccbackup selftest
```

最后一行应为 `===== 总结 ===== restic=OK age=OK rsync=OK repo=PASS restore=PASS`，约 2 秒。它在 `$TMPDIR` 建临时仓库，跑完初始化→备份→列快照→恢复→连数据校验，再验 age 加解密和 rsync 本地同步；临时密码和临时文件都会删掉。

## 密码：只让用户自己管

`ccbackup` **不读、不打印密码**。它只把密码文件的路径交给 restic，restic 自己读。

让用户自己在终端创建（不要让 Claude 代写、不要问用户要密码内容）：

```sh
mkdir -p ~/.cccodroid/backup
umask 077
printf '%s' '用户自己输入的密码' > ~/.cccodroid/backup/password
```

也可以设置 `RESTIC_PASSWORD_FILE` 或 `CCBACKUP_PASSWORD_FILE` 指向已有文件。密码丢了，仓库就恢复不了——提醒用户另存一份。

## 运行链路

```
ccbackup（$PREFIX/bin/ccbackup，本组件的 Python 包装）
  ├─ restic   $PREFIX/bin/restic（本组件，Termux 包）→ 仓库
  │    ├─ 本地仓库：文件系统目录
  │    ├─ sftp:   用底座 openssh 的 ssh（用户自己的密钥）
  │    └─ s3:/rclone: 等  restic 原生后端；rclone 组件可选，不装也能用 sftp/s3
  ├─ age      $PREFIX/bin/age（本组件）→ 单文件加密
  └─ rsync    $PREFIX/bin/rsync（本组件）→ 本地/SSH 同步

密码：~/.cccodroid/backup/password（或 RESTIC_PASSWORD_FILE）
  → 包装只传路径，restic 自己读；包装不读内容、不写日志
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `ccbackup` | 本组件 | 命令不存在 |
| `restic` / `age` / `rsync` | 本组件（Termux main） | 包装明确报「找不到 X」，退出码 2 |
| 密码文件 | 用户自己创建 | `ccbackup` 会停下并打印创建命令；不会静默用空密码 |
| `ssh` | 底座 | sftp 后端连不上，报 ssh 错误 |
| rclone | 可选组件 | 只影响 `rclone:` 后端；本地/sftp/s3 不受影响 |

- 远程仓库地址直接写 restic 的格式：`sftp:user@host:/backups/phone`、`s3:https://…/bucket`。
- 仓库地址记在 `~/.cccodroid/backup/repo`（只记地址，不是密码）。换仓库用 `ccbackup init --repo …`。

## 常用

```sh
ccbackup init --repo "$HOME/.cccodroid/backup/repo"   # 本地仓库
ccbackup init --repo sftp:user@host:/backups/phone     # 远程仓库（先配好 SSH 密钥）

ccbackup backup "$HOME/Documents" --tag docs           # 备份目录
ccbackup backup "$HOME/notes.md" --dry-run             # 先看会做什么
ccbackup snapshots                                     # 列快照
ccbackup check --read-data                             # 连数据一起校验（慢，但可靠）
ccbackup restore latest --target "$TMPDIR/restore"     # 恢复最近快照
ccbackup forget --keep-last 7 --prune                  # 只留 7 个，回收空间
```

- `backup` 默认带 `--tag ccbackup`；可以用 `--tag` 区分不同项目。
- 恢复先到 `$TMPDIR` 或空目录，确认文件没问题再覆盖原位置；覆盖前问用户。
- `forget --prune` 会重写仓库，耗时且不可中断，执行前告诉用户。
- 快照里记录的仍是**绝对路径**；恢复时会在 `--target` 下按原路径展开（例如 `target/data/user/0/…`）。先恢复到 `$TMPDIR` 的空目录确认，再考虑覆盖原位置。

## 常见坑

- **安卓上的扩展属性**：restic 直接用绝对路径会去读 `/data/user/0` 的 `user.serial`，普通应用没权限，退出码 3（快照其实已建）。`ccbackup` 已经改成 `chdir` 到父目录、只传文件名，绕开了这个错误；快照里显示的仍是绝对路径。
- **多个父目录会分成多个快照**：一次 `backup` 传了不同父目录下的路径时，包装会分开跑并提示。想合成一个快照，就把它们放进同一个目录再备份。
- **不要只备份到同一块盘**：手机丢了/坏了，本地仓库也一起没了。至少再配一个 sftp 或对象存储后端。
- **定期做恢复演练**：`check --read-data` 只证明数据没坏，恢复演练才证明拿得回来。
- restic 是加密的，忘了密码没有后门；不要把密码写进脚本、命令历史或 skill。
