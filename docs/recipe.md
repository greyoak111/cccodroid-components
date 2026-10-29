# 配方格式 v1 / Recipe format v1

一个组件 = `recipes/<id>/` 目录：

```
recipes/<id>/
  recipe.json        必需：组件定义
  skill/SKILL.md     必需：告诉 cccodroid 里的 Claude 怎么用它（装好后自动成为一个 skill）
  skill/*            可选：skill 的其余文件
  <其他文件>          可选：被 files 引用的包装脚本等
```

配方**只写"装哪些包"**，二进制由 CI 从 [Termux 官方仓库](https://packages.termux.dev) 取 `.deb`、逐个核对 SHA256、
把前缀从 `com.termux` 等长改写成 `cc.codroid` 后打包。仓库里不放任何二进制。

例外是 `fetch`：组件要用的东西官方仓库里确实没有时（例如 glibc 侧的 OpenCL —— 厂商的 `libOpenCL.so`
是 bionic 库，glibc 程序加载不了，官方仓库里也没有可用的替代），可以声明**该组件自己的上游构件**的 URL +
SHA256，CI 下载核对后打进包里。规则见下面「`fetch`：仓库外的上游构件」。**仓库里依然不放二进制，
市场自己的 Release 也不许当 fetch 的来源**（那等于绕开评审塞二进制）。

## recipe.json

| 字段 | 必需 | 说明 |
|---|---|---|
| `schema` | ✓ | 固定 `1` |
| `id` | ✓ | 和目录名一致；小写字母、数字、`-`，≤40 字符；`index` 保留 |
| `kind` | ✓ | `"termux"`（`$PREFIX/bin` 里的程序）或 `"glibc"`（Linux arm64 / glibc 程序，装在 `$PREFIX/glibc/`）。`"display"`（需要图形显示）为后续保留 |
| `revision` | ✓ | 配方修订号，≥1。发布版本是 `<上游版本>-r<revision>`；上游没变但配方改了（换了 skill、包装脚本）就加一 |
| `version` | | 自己指定上游版本（代替 `roots[0]` 的版本）；发布版本照样是 `<version>-r<revision>`。配 `fetch` 的组件用它——版本来自上游构件，不该跟着 `roots[0]` 走 |
| `name` / `desc` | ✓ | `{ "zh": "...", "en": "..." }`，App 里显示 |
| `roots` | ✓ | 要装的 Termux 包名。依赖自动求闭包；`roots[0]` 的版本就是组件的上游版本 |
| `bin` | ✓ | 入口命令（相对 `$PREFIX/bin`），App 里显示 |
| `selftest` | ✓ | 装好后能证明它能跑的一条命令，比如 `gh --version` |
| `license` | ✓ | 上游软件的许可证（SPDX 写法） |
| `category` | ✓ | 分类，App 扩展页的分类索引条按它分：`dev` 开发工具 · `office` 文档办公 · `media` 图像影音 · `science` 科学计算 · `eda` 电子设计 · `cad` 3D 与建模 · `ai` AI 推理 · `gpu` GPU 与驱动 · `net` 网络 · `other` 其他 |
| `repos` | | 额外的 Termux 仓库，目前只有 `"x11"` |
| `exclude` | | 闭包里不要的包（比如 postinst 会失败的可选依赖） |
| `files` | | 额外放进包里的文件：`{ "usr/bin/xxx": { "src": "xxx", "mode": "755" } }`。目标只能在 `usr/` 下；内容里的 `{{PREFIX}}` 会换成真实前缀 |
| `fetch` | | 仓库之外的上游构件（官方仓库里没有的东西），见下节 |
| `npm` | | 只在 npm 上发布的 Node 程序，按配方目录里的 `package-lock.json` 装，见「`npm`」一节 |
| `needs` | | `{ "shizuku": bool, "display": bool, "gpu": bool \| "adreno" \| "mali" }` —— 用到这些时如实写，App 据此提示。`gpu: "adreno"` = 只能用在高通骁龙（Adreno GPU）上（cccodroid 0.1.11 起）；`gpu: "mali"` = 只能用在 ARM Mali GPU（天玑、Exynos 等）上（cccodroid 0.3.3 起）。App 在没有对应设备节点的机器上直接不给装，更早的版本忽略 |
| `requires` | | 依赖的其它组件 id，例如 `["gpu-driver-glibc"]`。App 会让用户先装它们；有组件依赖时不让卸载被依赖的那个（cccodroid 0.1.11 起；更早的版本忽略） |
| `homepage` | | 上游主页 |
| `maintainers` | | 维护这个配方的 GitHub 用户名 |
| `notes` | | 给维护者看的备注 |

底座（cccodroid 工具包）里已有的包不会重复打进组件。所以组件**绑定底座版本**：
`bases.json` 里每个底座各打一份，用户装的是和自己工具包匹配的那份。工具包更新后组件显示"需要重装"。

## `fetch`：仓库外的上游构件

只在**官方仓库里确实没有**、而组件非用不可的时候写（典型：glibc 侧的 OpenCL —— 厂商的 `libOpenCL.so`
是 bionic 库，glibc 进程加载不了，官方仓库里也没别的可用）。每条是「落地路径 → 来源」，路径只能在 `usr/` 下：

```jsonc
"fetch": {
  "usr/glibc/lib/libOpenCL.so":   { "url": "https://…/libOpenCL.so", "sha256": "…",
                                    "why": "clvk 本体，clspv 内嵌在里面；官方仓库的 clvk 是 bionic 的，glibc 用不了" },
  "usr/glibc/bin/clspv":          { "url": "https://…/clspv", "sha256": "…", "mode": "755",
                                    "why": "离线把 OpenCL C 编成 SPIR-V" },
  "usr/glibc/lib/libOpenCL.so.1": { "link": "libOpenCL.so" }
}
```

要求：

- **sha256 写全**（64 位小写十六进制）：CI 下载后先核对再入包，对不上就构建失败。
- `mode`：权限（默认 `644`）。要装可执行文件就得写 `"755"`。
- `link`：只做一条软链、不下载，**目标只能写同目录的文件名**（不许绝对路径、不许带 `/`）。上游库的 SONAME 是
  `libX.so.1` 而文件叫 `libX.so` 时必须补这条 —— 链接过它的程序运行时找的是 `.so.1`。
- `why`：这是什么、为什么不能走 Termux 官方仓库。会进构建清单，给以后查的人看。
- `source` / `version`：出处、版本（只记账；默认 `pypi` / 从文件名猜）。配 `fetch` 的组件通常自己写 `version`。
- 不许指向**市场仓库自己**（Release、raw、codeload 都算 —— 那等于自带二进制），也不许 http。
- 只放**这个组件自己**运行要用的东西，不要顺手捎带别的工具；许可证必须允许再分发。
- `roots` 照写（决定跟着哪个底座打包、`roots[0]` 也是版本基准之一）；底座里已有的包不会重复打。

### 上游压缩包：`extract`

上游多半把 linux-aarch64 的程序打成压缩包发布（`d2-v0.9.0-linux-arm64.tar.gz` 这种）。这时**键写落地目录（以 `/` 结尾）**，
再加一个 `extract`，CI 下载、核对哈希后解开，按规则取一部分放进去：

```jsonc
"fetch": {
  "usr/lib/d2/": {
    "url": "https://github.com/terrastruct/d2/releases/download/v0.9.0/d2-v0.9.0-linux-arm64.tar.gz",
    "sha256": "ac2c028697199479acb321db1e3d68caee9f2ba492ed73caa3cd13f3829bf913",
    "why": "D2 声明式绘图（Go 静态程序，MPL-2.0）；Termux 官方仓库没有",
    "extract": { "strip": 1, "include": ["bin/d2", "LICENSE.txt"] }
  }
}
```

| `extract` 里的字段 | 说明 |
|---|---|
| `format` | `tar.gz` / `tar.xz` / `tar.bz2` / `tar` / `zip`。不写就按 url 的后缀认，认不出就必须写 |
| `strip` | 去掉开头几层目录（0–5）。上游包通常裹着一层 `d2-v0.9.0/`，写 `1` |
| `include` | 只取这些路径（去层之后的相对路径；写目录就连带下面全部）。**尽量写**：上游包常带演示程序、头文件、文档，全打进来白占用户空间。写了却在包里找不到会构建失败 |
| `exec` | 要补执行位的文件。zip 常常不带权限位，这时要写 |

要求（打包时 devkit 会查，市场的 `check-recipes` 也会查）：

- `sha256` 核对的是**下载下来的压缩包**。核对时以 GitHub 资产页显示的摘要为准：有的上游另附的 `.sha256` 文件对的其实是裸程序，不是压缩包（micromamba 就是这样）。
- 解出来的路径不许越出落地目录：带 `..`、绝对路径的条目直接失败；软链只许相对、只许指向落地目录里面；硬链接改成实打实的文件；setuid / setgid 和组、其他人的写权限一律去掉；设备文件之类跳过。
- 不收 `mode`（权限取包里的，补执行位用 `exec`）；`link` 条目照旧单独写。
- 解出的文件和本组件 Termux 包里的文件同路径会失败；和底座同路径的，审计会拦。
- **上游的 glibc 动态程序解进 `usr/glibc/opt/<组件>/`**。它们的解释器写死 `/lib/ld-linux-aarch64.so.1`，安卓上没有，审计只在这个目录下把它当提醒，放别处直接拦。包装脚本要 `unset LD_PRELOAD` 再经 `$PREFIX/glibc/lib/ld-linux-aarch64.so.1 --library-path …` 启动（照抄 `recipes/blender/lib/env.sh`），它要的 `libstdc++.so.6` 这类库靠 `roots` 带上 `gcc-libs-glibc` 等 glibc 包。
- 静态链接（Go 程序、musl 静态）的不用进 `usr/glibc/`，放 `usr/lib/<组件>/` 就行。
- AppImage 暂不支持（要先弄清楚怎么无头解开、怎么启动）。

## `npm`：只在 npm 上发布的 Node 程序

上游只发 npm 包、Termux 官方仓库里没有时用（例：Cloudflare 的 wrangler）。配方目录里放
`package.json` 和 `package-lock.json`，recipe.json 写：

```jsonc
"roots": ["nodejs"],
"npm": { "dir": "usr/lib/<组件名>", "why": "为什么不走 Termux 官方仓库" }
```

CI 在 `dir` 下跑 `npm ci --os=android --cpu=arm64 --ignore-scripts --omit=dev`，把 `node_modules` 整个打进包。
入口自己用 `files` 写包装脚本（`exec {{PREFIX}}/bin/node {{PREFIX}}/lib/<组件名>/node_modules/…`）。

要求（`tools/check-recipes.mjs` 会查）：

- `package.json` 的依赖**写死版本**（不许 `^` `~` `*`、不许 git/本地路径）。
- `package-lock.json` 的 lockfileVersion ≥ 2；每个包都从 `https://registry.npmjs.org/` 来、带 sha512 integrity。
- 不跑安装脚本（`--ignore-scripts`）：靠 postinstall 下载二进制的包装不上，二进制改走 `fetch`。
- 装出来的包声明了 `os` / `cpu` 的，必须包含 android / arm64，否则构建失败。
- 生成 lock：在任意机器上 `npm install --package-lock-only --os=android --cpu=arm64`，提交前核对 diff。

## `pip`：Termux 仓库没有的纯 Python 依赖

有的 Termux 包在 postinst 里现场 `pip install`（例：matplotlib 会去 PyPI 拉 cycler / fonttools / packaging /
pyparsing / python-dateutil / six）。不处理的话：装组件时要联网、版本不定、离线就装坏，拉下来的文件也不进组件记录，
卸载删不掉。把这些依赖钉进配方：

```jsonc
"pip": {
  "why": "matplotlib 的纯 Python 依赖（Termux 仓库没有）",
  "wheels": [
    { "url": "https://files.pythonhosted.org/packages/…/six-1.17.0-py2.py3-none-any.whl", "sha256": "…" }
  ]
}
```

devkit 下载、核对 sha256，照 pip 的布局解进底座 python 的 site-packages（带 dist-info，INSTALLER 记成
`cccodroid-devkit`），`console_scripts` 生成入口脚本，`.data/` 的 scripts / data 放进 `bin/` 和 `$PREFIX`。
postinst 里的 pip 看到依赖已满足就不再联网。

要求（`tools/check-recipes.mjs` 会查）：

- 只收 `files.pythonhosted.org` 上的 `*-py3-none-any.whl` / `*-py2.py3-none-any.whl`（纯 Python）。带 C 扩展的包走 Termux 仓库，那里没有就算做不了。
- 每个 wheel 写 PyPI 页面上的 SHA256；同一个包只写一次。
- 怎么知道要带哪些：看包 METADATA 的 `Requires-Dist`，减掉 Termux 包已经提供的；或者在 cccodroid 终端里把组件装上、看 postinst 的 pip 输出了哪些 `Downloading`。
- **CI 自检跑首次运行时设了 `PIP_NO_INDEX=1`**：少带一个，postinst 的 pip 就装不上、selftest 的 import 失败。审计报告里 postinst 有 pip、配方又没写 `pip` 的，会单独提醒。

## skill/SKILL.md

```markdown
---
name: <skill 名，小写和 ->
description: <一句话：什么时候该用它>
---

正文：怎么调用、常见坑、哪些操作要先征得用户同意。
```

要求：

- 涉及登录的，**绝不让 Claude 读取或打印令牌/密码**，让用户自己在终端里登录。
- 会对外发布、删除、花钱的操作，写明"先问用户"。
- 命令一律带非交互参数（cccodroid 里 Claude 没有 TTY）。

## 版本与发布

- CI 按 `(id, 版本, 底座)` 判断是否已发布，已发布的跳过；要重打就加 `revision`。
- 每个组件一个 Release（tag = id），资产 `<id>-<版本>-for-<底座前 12 位>.tar.gz` 和同名 `.json`。
- 索引 `components.json` 在 `index` Release，用 ed25519 签名（`components.json.sig`），App 内置公钥验签。

## 真机验证

`verified.json`：

```json
{ "gh": { "2.102.0-r1": { "13ba8abc3e53": {
  "date": "2026-10-15", "device": "Lenovo TB320FC / Android 15", "app": "cccodroid 0.1.9",
  "checks": "装好、selftest 通过、skill 装上", "by": "greyoak111" } } } }
```

只有在真机上装过、`selftest` 过了、skill 装上的构建才写进去；`checks` 如实写做了哪些检查。
没写的构建在 App 里显示"未经真机验证"。

**换底座不用全部重测**：出索引时，同一版本在别的底座上验证过的构建，如果组件自己的包（名字 + sha256）没变、
它依赖链里由底座提供的包（构建清单的 `baseDeps`）在两个底座里版本都相同、它 requires 的组件在新底座上也算验证过，
就自动继承那条记录（索引里带 `inherited`：从哪个底座、为什么）。只有真变了的才进待测列表。

**批量真机验证**：`node tools/verify-device.mjs --pending --app "cccodroid <版本>" --by <GitHub 用户名>`
把当前工具包下所有还没验证（含继承）的组件按依赖顺序挨个验完，最后打印一份合并好的记录。
加 `--pr` 就直接把通过的记录并进 `verified.json` 开 PR（用 gh，要对本仓库有写权限；不用 clone）。
