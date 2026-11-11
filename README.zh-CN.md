# cccodroid-components

[English](README.md)

[cccodroid](https://github.com/greyoak111/cccodroid)（安卓上的 Claude Code 启动台）的社区组件配方仓库。

组件是可选安装的软件包，在 cccodroid 的「扩展」页安装，比如 GitHub 命令行、LibreOffice、电路仿真、本地大模型推理。装好后 cccodroid 里的 Claude 就能用它：每个组件自带一个 skill，告诉 Claude 怎么用、有哪些坑。

cccodroid 从 0.1.10 起读这个仓库。浏览器（Chromium）这类预置组件仍由 cccodroid 仓库发布。

## 组件列表

| id | 是什么 | 分类 | 说明 | 上游许可证 |
|---|---|---|---|---|
| `gh` | GitHub 命令行：PR、Issue、Release、Actions | 开发 | | MIT |
| `godot` | Godot 4 引擎：无头运行、导出 Android APK | 开发 | | MIT |
| `diagrams` | 用文本画图：Graphviz（流程图、结构图）+ PlantUML（时序图、类图），出 SVG / PNG，支持中文 | 开发 | | EPL-2.0 AND GPL-3.0-or-later AND GPL-2.0-with-classpath-exception |
| `hugo` | Hugo：从 Markdown 生成静态网站，本地预览、构建成品 | 开发 | | Apache-2.0 |
| `re-tools` | 逆向分析：rizin 看 ELF / so、反汇编；binwalk 扫固件里的压缩包和文件系统 | 开发 | | LGPL-3.0-or-later AND MIT |
| `blender` | Blender 4.3 无头版：用 Python 脚本做合成、动效、出片，3D 渲染走 Adreno GPU（Vulkan 1.4） | 图像影音 | 首次使用下载本体：Debian 约 267 MB + GPU 用的补丁版 Mesa 约 11 MB（安装方法沿用 [blender-cli-android](https://github.com/greyoak111/blender-cli-android)） | GPL-2.0-or-later |
| `lilypond` | LilyPond：用文本写乐谱，排版成出版级 PDF，也能出 PNG / SVG / MIDI | 图像影音 | | GPL-3.0-or-later |
| `music` | 音乐生产工作流：MIDI → 音频（fluidsynth）、SuperCollider 合成、sox 后期、aubio 分析 | 图像影音 | 内置 GM 音色库（31 MB） | LGPL-2.1-or-later AND GPL-3.0-or-later AND GPL-2.0-only AND LicenseRef-GeneralUser-GS-2.0 |
| `libreoffice` | LibreOffice 无头版：文档互转、出 PDF | 办公 | | MPL-2.0 AND LGPL-3.0 |
| `pandoc` | Pandoc：Markdown、Word、HTML、EPUB、PDF 互转，PDF 用底座的 typst 出 | 办公 | | GPL-2.0-or-later |
| `pdf-tools` | PDF 工具箱：合并、拆分、旋转、加解密、压缩、提文字、转图片（qpdf、poppler、mutool） | 办公 | | Apache-2.0 AND GPL-2.0-or-later AND AGPL-3.0-or-later |
| `ocr` | OCR：图片和扫描版 PDF 识别成文字，简中、繁中、英文，也能出可搜索 PDF | 办公 | 语言模型安装时另外下载 | Apache-2.0 AND GPL-2.0-or-later |
| `latex` | LaTeX（Tectonic）：.tex 编译成 PDF，支持 ctex / xeCJK 中文和 beamer | 办公 | 首次编译按需下载 TeX 资源并缓存 | MIT |
| `llama-cpp` | llama.cpp：本地大模型推理 | AI | 模型自备（.gguf） | MIT |
| `openscad` | OpenSCAD：用脚本建 3D 模型，导出 STL 等格式，带 MCAD 库 | 3D 与建模 | | GPL-2.0-only |
| `octave` | GNU Octave：MATLAB 兼容的数值计算，无头出图（带 gnuplot） | 科学计算 | | GPL-3.0-or-later AND gnuplot |
| `sci-python` | 科学计算 Python：numpy、scipy、matplotlib、Pillow、pyarrow，都是预编译包 | 科学计算 | | BSD-3-Clause AND PSF-2.0 AND MIT-CMU AND Apache-2.0 |
| `ngspice` | ngspice：电路仿真 | 电子设计 | | BSD-3-Clause AND LGPL-2.1-only |
| `gnucap` | gnucap：电路仿真 | 电子设计 | | GPL-3.0-or-later |
| `iverilog` | Icarus Verilog：Verilog 仿真、波形出图 | 电子设计 | | GPL-2.0-or-later |
| `yosys` | Yosys：Verilog 综合 | 电子设计 | | ISC |
| `gpu-driver` | 让命令行程序用上 Adreno GPU：Turnip（Vulkan）+ zink（OpenGL / GLES） | GPU | 仅骁龙 | MIT |
| `gpu-driver-glibc` | 同上，给 glibc（Linux arm64）程序用，带 `lgpu-run` 启动器 | GPU | 仅骁龙 | MIT |
| `gpu-driver-mali` | 让命令行程序用上 Mali GPU：借系统加载器接入厂商 Vulkan / GLES，免 root | GPU | 仅 Mali（天玑等）；只支持 Termux 程序，不带 OpenCL | Apache-2.0 |
| `clvk-glibc` | OpenCL（clvk，跑在 Vulkan 上），给 glibc 程序用 | GPU | 仅骁龙；依赖 `gpu-driver-glibc` | Apache-2.0 |
| `gpu-bench` | GPU 信息与跑分（clinfo / vkmark / clpeak） | GPU | 仅骁龙；依赖 `gpu-driver` | CC0-1.0 AND GPL-3.0-or-later AND GPL-2.0-or-later |
| `cloudflare` | Cloudflare 官方命令行（wrangler）：部署 Workers / Pages，管 R2 / KV / D1，本地跑 `wrangler dev` | 网络 | 用 `cf-login` 粘贴令牌登录 | (MIT OR Apache-2.0) AND Apache-2.0 |
| `rclone` | rclone：本地目录、WebDAV、S3、Google Drive 等云存储的同步与备份 | 网络 | | MIT |

表里的组件都在当前工具包（devkit-2026.10.28）上真机验证过：有的直接验，有的从旧工具包上的验证记录自动继承（见下面「真机验证」）。具体记录在 [`verified.json`](verified.json)。

「仅骁龙」的组件，App 在别家芯片的设备上不给装。有依赖的组件，App 会先让你装好依赖，依赖也不能在它之前卸载。

## 已上架、还没真机验证的组件

App 里会标「未经真机验证」，装之前先看说明。

- `openai-bridge`（预览）：把你自己有权使用的 OpenAI Chat Completions API 转成本机的 Anthropic Messages 接口，再到「设置 → 接口与型号 → 自定义接口」里填本机地址。请求会发到你配置的远端，可能收费；服务只监听本机回环地址。装好后在终端运行 `openai-bridge configure` 配置；从 App 卸载前先运行 `openai-bridge uninstall --yes`。包体约 107 MiB。源仓库：[chenshi723/cccodroid-openai-bridge](https://github.com/chenshi723/cccodroid-openai-bridge)。
- `bilibili-mcp`（MCP）：让 Claude 读 B 站——视频信息、章节、评论、字幕、搜索、收藏夹，只读。装好后自动注册为 MCP 服务 `bilibili`（cccodroid 0.6.16 起）。字幕、搜索、收藏夹要登录：在终端运行 `bilibili-mcp setup`。上游：[XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp)（Apache-2.0）。
- `bili-groups`（MCP）：让 Claude 整理 B 站关注——列分组、建分组、批量移分组。**会改你的账号数据。** 装好后自动注册为 MCP 服务 `bili-groups`（cccodroid 0.6.16 起）；在终端运行 `bili-groups login` 扫码登录。脚本作者 chenshi723，cccodroid 群友分享（Apache-2.0）。
- `skia-video`（图像影音）：用 Skia 逐帧绘制文字、图形、图片和关键帧动画，配合底座的 ffmpeg 生成视频、在现有视频上叠加图层，或导出 PNG 静帧。约 3 MB。
- `code-quality`（开发）：shellcheck、shfmt、ruff 三件套，`code-quality check` 默认只读，`fmt --write` 才改文件。
- `backup`（网络）：restic 加密备份、age 文件加密、rsync 同步，`ccbackup` 包装常用流程。仓库密码文件由你自己建，包装不读内容。
- `android-build`（开发）：Gradle 9.9.1，配合底座的 JDK 21、aapt2、d8、apksigner 在手机上构建安卓工程。Android SDK 不随包：自己下载 command-line tools 后用 `android-build setup-sdk` 解开，许可由你在终端确认。约 128 MB。
- `speech`（AI）：sherpa-onnx 语音转文字（Whisper small）与文字转语音（MeloTTS 中英）。模型不在包里，按需下载：识别约 358 MB、朗读约 160 MB，下载前会先问你。
- `databases`（开发）：本机 Valkey 键值库（兼容 Redis 命令），只听 127.0.0.1，`ccdb start / stop / status`。暂不含 PostgreSQL。
- `data-tools`（开发）：miller（CSV/TSV/JSON）、xmlstarlet、xmllint。
- `math-min`（科学计算）：qalc 计算器、PARI/GP 数论、GNU units 单位换算、gnuplot 无头作图。和 `octave` 共用 gnuplot。
- `photo-min`（图像影音）：exiv2 照片元数据、G'MIC 滤镜、potrace 位图转矢量、zbarimg 识别条码二维码。
- `pandas`（科学计算）：pandas 3.1 表格数据分析，自带 numpy，不依赖 `sci-python`（和它共用 numpy、libopenblas）。
- `apk-tools`（开发）：apktool 解包与重打包、dex2jar，用来检查你自己的或已获授权的 APK。不带 jadx。
- `ml-tflite`（AI）：TensorFlow Lite 2.21 CPU 推理，自带 numpy；模型自备。
- `minecraft-server`（其他）：原生跑 Paper 1.21.11 服务端，Java 21 由底座提供。第一次启动会从 Mojang 官方下载原版服务端（约 54 MB）并打补丁，实测近 9 分钟；要你自己读并同意 [Minecraft EULA](https://aka.ms/MinecraftEULA)。默认只听本机，局域网联机要显式打开。
- `qq-bot`（网络）：在手机上原生跑 Linux 版 QQ + NapCat 的 OneBot 机器人，只回复白名单里的会话，明确以 AI 身份回复。第一次 `setup` 经你同意后从腾讯官方和 NapCat 的 GitHub Release 下载，共约 307 MB、装后约 1.1 GB。**免责声明：本组件是社区作品，与腾讯、QQ、NapCat 均无关联，未获官方授权或认可；它通过非官方框架接管 QQ 客户端，可能违反腾讯的服务协议，登录的 QQ 号可能被限制、冻结或封禁，风险与损失由使用者自行承担，建议用小号。机器人的回复由 AI 生成，使用者对它发出的全部内容负责，须遵守法律法规、平台规则和群规；不得用于批量注册、养号、刷屏、营销群发或冒充真人。NapCat 限非商业使用。组件按「现状」提供，不作任何担保。**

## 怎么运作

- **仓库里只有配方，没有二进制。** 配方写的是 Termux 包名。CI 从 Termux 官方仓库下载 `.deb`，逐个核对 SHA-256，把前缀从 `com.termux` 等长改写成 `cc.codroid`，再打包。官方仓库里确实没有、而组件运行又必需的上游构件，可以用 `fetch` 声明 URL 和 SHA-256，由 CI 下载核对。
- **每个工具包版本各打一份。** 组件只装 cccodroid 工具包里没有的东西，所以 [`bases.json`](bases.json) 里列的每个工具包版本都要分别打包，App 装和用户工具包匹配的那份。cccodroid 发了新工具包，就在这里加一行。
- **索引签名。** CI 把 `components.json` 发到 `index` Release，并用 ed25519 签名（`components.json.sig`）。App 用内置公钥验签，索引或包被篡改就装不上。
- **真机验证。** `verified.json` 记录的是在真机上装过、跑过自检、卸干净了的构建；没记录的，在 App 里显示「未经真机验证」。换了新工具包后，如果组件自己的包和它用到的底座包都没变，CI 会自动继承旧的验证记录，只有真变了的才需要重新验证。
- **审计。** 每个 PR 都会跑格式检查（`check-recipes.mjs`），再用 `audit.mjs` 照正式流程真打一次包，检查这些：
  - 每个程序缺不缺库、脚本的解释器在不在；
  - 有没有盖掉底座的文件、有没有残留的 Termux 路径；
  - skill 里有没有需要人看一眼的地方（令牌、联网下载、删除 / 发布、提权）。

  审计报告按风险分成三级：🟢 看报告即可，🟡 要读脚本和 skill，🔴 要逐行审。

## 添加组件

先读 [组件编写规则](.claude/skills/component-authoring/SKILL.md)，再看 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [配方格式](docs/recipe.md)。不知道做什么的话，看 [组件征集](docs/wanted.md)：维护者不再自己做的候选和已有的实测结论都在里面，认领在 [#52](https://github.com/greyoak111/cccodroid-components/issues/52)。最快的办法是复制 `recipes/gh/` 来改；带包装脚本的复杂例子可以参考 `recipes/iverilog/` 或 `recipes/llama-cpp/`。

用 AI 助手写组件的话，仓库根目录的 [AGENTS.md](AGENTS.md) 就是写给它看的。

反代、共享或转售账户、破甲、批量操控账号这几类组件，市场一律不收，已上架的发现即下架（见 [CONTRIBUTING.md](CONTRIBUTING.md) 的「不收」）。这些做法最后坑的是普通用户，cccodroid 的立场写在 [本项目反对的做法](https://github.com/greyoak111/cccodroid/blob/main/README.zh-CN.md#本项目反对的做法)。

## 致谢

谢谢这些朋友（按时间先后）：

- **[CCB-Fox](https://github.com/CCB-Fox)**：投稿 [`gpu-driver-mali`](recipes/gpu-driver-mali/)（#46），第一个外部组件。在天玑 9400 上实测出不用 root、借系统 Vulkan 加载器用上厂商 Mali 驱动的办法，组件的 `needs.gpu: "mali"` 也因此而来。
- **[Cosmosophius](https://github.com/Cosmosophius)**：天玑 9300（Mali-G720）的完整实测报告（#47），独立验证了同一条路，并测出了计算性能、扩展支持和走不通的方向。

GitHub 的「贡献者」列表只统计代码提交。报告问题、测试机型同样是贡献，都会记在这里。

## 许可证

本仓库里的配方、脚本和文档采用 Apache-2.0。打包的软件各自保留上游许可证，记录在各配方里。
