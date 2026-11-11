---
name: code-quality
description: Shell / Python 代码检查与格式化（shellcheck + shfmt + ruff，cccodroid 组件）：写完脚本或改动 Python 文件后跑一遍，找 quoting/引用错误、统一 shell 缩进、跑 ruff 检查与格式检查。用户要求检查、格式化、lint 代码时使用。
---

# 代码质量：shellcheck + shfmt + ruff

本机装了三个 Termux 官方包，外加一个非交互入口 `code-quality`。全部离线运行。

## 先自检

```sh
code-quality selftest
```

最后一行应为 `===== 总结 ===== shellcheck=OK shfmt=OK ruff=OK check=PASS`，约 1 秒。它在 `$TMPDIR` 里造一组坏样本和一组好样本，确认坏样本会被拦下、好样本能通过，然后删掉临时目录。

## 运行链路

```
code-quality（$PREFIX/bin/code-quality，本组件的 Python 包装脚本）
  ├─ shellcheck  $PREFIX/bin/shellcheck（本组件，Termux 包）→ .sh / .bash
  ├─ shfmt       $PREFIX/bin/shfmt（本组件，Termux 包）→ .sh / .bash
  └─ ruff        $PREFIX/bin/ruff（本组件，Termux 包）→ .py

三个工具各自是独立原生程序；包装脚本只负责找文件、分组调用、汇总退出码。
不联网、不读配置文件以外的状态；ruff 用 --no-cache，不会在项目里留缓存。
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `code-quality` | 本组件 | 命令不存在 |
| `shellcheck` / `shfmt` / `ruff` | 本组件（Termux main） | 包装脚本明确报「找不到 X」，退出码 2；不会跳过检查假装成功 |
| Python 3 | 底座 | 包装脚本起不来（`#!{{PREFIX}}/bin/python3`） |

## 常用

### 检查（默认只读）

```sh
code-quality check                 # 当前目录下所有 .sh/.bash/.py
code-quality check src/ scripts/   # 指定目录或文件
```

- 找到问题退出码 1，全部通过退出码 0，工具缺失退出码 2。
- 输出就是三个工具自己的报告；最后一行汇总 `shell=%d python=%d -> PASS/FAIL`。
- 默认跳过 `.git`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.ruff_cache`、`.mypy_cache`、`site-packages`。

### 看格式差异 / 写回

```sh
code-quality fmt                  # 只显示 shfmt/ruff format 的差异，不改文件
code-quality fmt --write          # 真写回；先征得用户同意
```

- `fmt` 不带 `--write` 时，发现差异退出码 1。
- `--write` 会同时改 shell 和 Python 文件，而且**不可撤销**。执行前把要改的目录告诉用户，得到同意再跑；改完建议让用户过一眼 `git diff`。
- ruff 的项目配置（`pyproject.toml` / `ruff.toml`）由 ruff 自己发现；不要为了「跑通」去改用户配置。

## 常见坑

- **shellcheck 的 SC2086 最常见**：`echo $var`、`[ $x = y ]` 要加引号。不要用 `# shellcheck disable=SC2086` 掩盖，先判断是不是真需要分词。
- **shfmt 默认用 tab 缩进**，不是四个空格；已有项目如果统一用空格，先看项目里有没有 `.editorconfig` 或既有风格，别直接 `--write` 把整个仓库改一遍。
- **ruff 的 `check` 和 `format` 是两件事**：`check` 抓未使用导入、未定义名字等；`format` 只管排版。两个都跑才算完整。
- 生成代码、第三方 vendored 代码、`build/` 产物不要扫；用显式路径缩小范围。
- 文件很多时分批调用（脚本内部按 80 个一组），不会因为命令行太长失败。
