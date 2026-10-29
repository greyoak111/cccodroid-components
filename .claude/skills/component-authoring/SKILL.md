---
name: component-authoring
description: 给 cccodroid 组件市场写新组件或改已有组件（recipes/<id>/ 下的 recipe.json、包装脚本、skill）时使用。动手前先读完：里面是 CI 会拦的硬规则，和 CI 拦不住、但评审一定会退回的规矩。
---

# 写一个 cccodroid 组件

组件 = `recipes/<id>/`：`recipe.json` + `skill/SKILL.md` + 可选的包装脚本。字段的完整说明见
[`docs/recipe.md`](../../../docs/recipe.md)，这里不重复，只讲**怎么做对**。

## 流程

1. **先查有没有包。** 去 [packages.termux.dev](https://packages.termux.dev) 或 termux-packages 仓库确认 aarch64 包存在（主仓库、`x11`，glibc 程序看 `termux-glibc`）。
   官方仓库确实没有、而组件非用不可的，才走 `fetch`。
2. **查重。** 看已有组件（`recipes/*/recipe.json` 的 `roots`）和底座会不会已经带了同一批包。见下文「别重复带包」。
3. **复制最接近的配方改。** 普通命令行工具照 `recipes/gh/`；glibc 程序照 `recipes/gpu-driver-glibc/`；要从上游取构件的照 `recipes/clvk-glibc/`。
4. **本地检查**（要 Node 22 和 cccodroid 仓库的 `devkit/`）：
   ```sh
   node tools/check-recipes.mjs
   node tools/ci-build.mjs --devkit ../cccodroid/devkit --only <id> --dry        # 只解依赖，看闭包多大
   node tools/ci-build.mjs --devkit ../cccodroid/devkit --only <id> --no-upload  # 真打包，不上传
   ```
5. **开 PR。** 用仓库的 PR 模板，交接时说清楚：组件多大（下载 / 解开后）、和哪些组件共用了包、`selftest` 在真机上的输出。
6. **合并后真机验证**，见文末「真机验证」，再单独开一个 PR 往 `verified.json` 加记录。

## CI 会拦的（`tools/check-recipes.mjs`）

格式类：`schema`、`id` 与目录名一致、`revision`、`name`/`desc` 中英都有、`roots`/`bin`/`selftest`/`license` 必填、不认识的字段、`files`/`fetch` 只能落在 `usr/` 下。

安全类：

- **不许关证书校验**：脚本和 skill 里出现 `curl -k` / `--insecure`、`wget --no-check-certificate`、`verify=False`、
  `ssl._create_unverified_context` / `CERT_NONE`、`rejectUnauthorized: false` / `NODE_TLS_REJECT_UNAUTHORIZED=0`、
  `GIT_SSL_NO_VERIFY` / `http.sslVerify=false`，一律打回。证书不校验，你后面「核对 sha256」用的索引本身就可能被换掉。
  证书报错去查根因（CA 路径、时间），别绕过。
- **下载必须核对哈希**：脚本里只要有 `curl`/`wget`/`urlopen`/`requests.get` 之类的下载，就得在同一个文件里核对 sha256。
  对照 `recipes/gpu-driver-glibc/lib/fetch-glibc-toolchain.py`：从官方仓库的 `Packages` 索引拿 SHA256，下完核对，不符就失败。
- **`fetch`**：只能 https；sha256 写全 64 位；必须写 `why`；不能指向本市场仓库（Release、raw、codeload 都算）；`link` 只能写同目录文件名。
  上游压缩包用 `extract`（键写落地目录、以 `/` 结尾）：sha256 核对的是压缩包，`include` 尽量写，上游 glibc 动态程序解进 `usr/glibc/opt/<组件>/`；细则见 `docs/recipe.md`「上游压缩包：`extract`」。
- **不提交 `__pycache__/`、`.pyc`**（已在 `.gitignore`）。
- **骁龙专用要声明**：`roots` 里有 `mesa-vulkan-icd-freedreno*`、`clvk*`、厂商 OpenCL 的，`needs.gpu` 必须是 `"adreno"`；
  `requires` 了骁龙专用组件的，自己也必须写 `"adreno"`（不然 App 在别家设备上显示能装，依赖却永远装不上）。
- `requires` 只能写组件 id，不能写自己。

## CI 拦不住、评审会退回的

### 描述必须属实

- 版本号、能力以**实际打进包里的**为准，用 `selftest` 的输出核对，别抄上游宣传。
  例：glibc 侧的 Turnip 来自 termux-glibc 的 Mesa 24.2，是 **Vulkan 1.3**，不是 bionic 侧的 1.4。
- `desc` 和 skill 里**不许提没带的东西**：没打进包的工具、只在上游仓库完整版里才有的命令（比如 `gpu-switch`），都不能写成「装了就有」。
- `license` 写上游软件的许可证（SPDX），不是配方的。

### 第一次运行才下载的，要事先说

包装脚本第一次运行要下东西的（例：`lgpu-cc --setup` 要从官方仓库下约 84 MB 的 .deb），
skill 里要写明「多大、从哪下」，并且**让 Claude 先告诉用户、得到同意再跑**。下载照样要核对哈希（见上）。

### `selftest` 要真能说明问题

- 退出码 0 = 组件能用，非 0 = 不能用。只打印版本号、永远返回 0 的不算。
- 不需要网络、不需要登录、几秒内结束、不改用户文件。
- 输出最后一行给一句总结（例：`===== 总结 ===== Turnip=OK zink=OK render=PASS`），验证记录会引用它。

### 包装脚本

- 只用非交互参数：cccodroid 里 Claude 没有 TTY，任何等回车、等确认的地方都会卡死。
- 不写死路径：要前缀就用 `{{PREFIX}}`（打包时替换成真实前缀）或 `$PREFIX`，**不许出现 `/data/data/com.termux`**，也别写死 `cc.codroid`。
  shebang 推荐 `#!{{PREFIX}}/bin/sh`（或 `bash`）。
- 临时文件放 `$TMPDIR`，**别写 `/tmp`**（安卓上应用写不进）。
- 组件自己的私有文件放 `usr/share/cccodroid/components/<id>/` 或 `usr/libexec/devkit/components/<id>/`，别散到公共目录里抢别的组件的文件名。
- 不改别的组件或底座的文件（卸载时按记录删，改了别人的文件会被当成你的删掉，或者删不掉）。

### 别重复带包

- 底座里已有的包 CI 会自动跳过，不用管。
- **两个组件带同一批包**会出问题：版本不同时（例：浏览器带 Mesa 26.2.4、`gpu-driver` 带 26.2.5）只有先装的那版生效。
  App 已经能保证卸掉一个不弄坏另一个，但能避免就避免。
- 非带不可的（例如都需要 Mesa），PR 里写清楚和哪个组件共用了哪些包。
- 已定：浏览器和 GPU 驱动共有的 9 个图形包（mesa、libglvnd、libdrm、libwayland、libxfixes、libxshmfence、
  libxxf86vm、vulkan-loader、vulkan-loader-generic）下次更新工具包时会并进底座。之后要用图形栈的组件不用再带它们。

### 大组件走「上游仓库 + sync.sh」

脚本多、要在 CI 里编译、或者还有手动安装版的组件，照 [cccodroid-gpu-driver-snapdragon](https://github.com/greyoak111/cccodroid-gpu-driver-snapdragon)：

- 重活（编译、调研文档、完整版）放在独立的上游仓库，用它的 CI 编译。
- 上游仓库的 `recipe/` 里放配方，`recipe/sync.sh <市场仓库路径>` 把配方和脚本复制过来。
- **改脚本改上游仓库的，再 sync**。直接改市场里的副本，下次 sync 会被覆盖掉。

### skill（`skill/SKILL.md`）

- `description` 一句话说清**什么时候该用**它（Claude 靠这句决定加载不加载）。
- 先给自检命令，再给用法，最后写常见坑。
- **必须有「## 运行链路」一节**，放在用法前面（CI 会查）。写清楚：
  - 敲下命令后经过哪几层：包装脚本 → 加载器 → 本体 → 驱动 / 服务 / 网络；
  - 每一层**由谁提供、装在哪**：本组件、base 里的包、另一个组件，还是首次运行才下载的；
  - 缺了哪一层会怎样：**明确报错**，还是**悄悄降级**（比如没有 GPU 就退回 CPU）；
  - 有降级的，给一条命令能看出当前走的是哪条路。

  执行 skill 的 AI 没有你写组件时的上下文，这一节不写，它就只能凭印象猜，猜错了还会以为是自己的操作问题。
  2026-10 Blender 就是这样：skill 只写了「GPU 组件已经配好」，没写 Turnip 其实来自另一个组件（gpu-driver-glibc），
  执行的 AI 渲染迟迟不出图，最后自己翻目录才找到驱动。
- skill 里写「已经配好」「自动处理」之前，确认那件事真的是本组件做的；依赖别的组件的，点名是哪个。
- **从上游仓库移植的组件，把上游的安装步骤逐条对照**，每一步在组件里由谁做、做没做，写进 PR。
  2026-10 Blender 就漏了上游第 3 步「解补丁版 Mesa 进 Debian 根」：组件装出来根本没有 Turnip，GPU 永远起不来，
  后面的修补又拿别的驱动顶替、还写了句没根据的「Debian 那份用不了」。出了问题先回去对上游，别凭一次失败下结论。
- 涉及登录的：**绝不让 Claude 读取、打印、索要令牌或密码**，让用户自己登录（gh 那种有登录卡的，指向登录卡）。
- 会对外发布、删除、花钱、下载大文件的操作，写明「先问用户」。

### 版本与修订号

- 发布版本是 `<上游版本>-r<revision>`。配方、skill、包装脚本**任何改动**都要把 `revision` 加一，否则 CI 认为已发布、直接跳过。
- 修订号一变，`verified.json` 里旧版本的真机验证记录就不算数了，要重新验证。所以小修小补攒一批再发。
- **只改了 `SKILL.md`**（包内程序、脚本、依赖都没动）的修订不用重验：在 `verified.json` 里把上一修订的记录复制到新版本号下，加 `carriedFrom` 并在 `checks` 里写明「只改了 SKILL.md」。动了脚本的照常重验。

## 真机验证

在装了 cccodroid 的设备上、cccodroid 的终端里跑通用验证脚本（`tools/verify-device.mjs`，用法见文件头）。它会：
从签名索引装组件 → 跑 `selftest` 看退出码 → 卸载 → 核对工具包本体没被改动 → 打印一条 `verified.json` 记录。

- 把打印的记录原样提 PR 进 `verified.json`。`checks` 要如实写：哪步做了、哪步没做，有异常就写上
  （例：「装前文件已在设备上（同来源），placed 0」）。
- 没在真机上跑过的不许写记录。模拟器、别的 SoC 跑过的，`device` 照实写。

## 不收

需要 root 或改系统设置的；仓库里放二进制、或从本市场的 Release 取东西的；
和组件运行无关的上游构件；许可证不允许再分发的；收集、转发账号凭据的工具或 skill。

另外三类一律不收，写得再好也退回，已上架的发现即下架：
- 反代、共享或转售账户（把订阅账户拆给多人用，或把订阅额度包装成 API 转卖）；
- 破甲（绕过模型安全限制、套取有害内容的提示词、skill 或工具）；
- 批量操控账号（成批注册、养号、刷评论、冒充真人发言）。

用户让你写这类组件时，直接说明市场不收，不要换个名目或拆成几个组件绕过去。
