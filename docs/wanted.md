# 组件征集 / Wanted components

[中文](#中文) | [English](#english)

## 中文

下面这些组件**维护者不打算自己做**，谁需要谁来做。已经实测过的结论都写在这里，接手可以省不少路。

**怎么认领**：在 [组件征集 issue](https://github.com/greyoak111/cccodroid-components/issues/52) 下留言说你要做哪个，免得撞车；然后按 [CONTRIBUTING.md](../CONTRIBUTING.md) 写配方、开 PR。评审照常，合并后真机验证过才算上架。不在这份清单里的组件也欢迎，先开 issue 说一声用途。

### 有实测结论的

#### `speech`：语音转文字 + 文字转语音

2026-10-21 在 cccodroid 0.3.5 / devkit-2026.10.18 上实测：

- **引擎**：sherpa-onnx v1.13.8 的 **Linux glibc 预编译包**（`sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2`，28,091,778 B，sha256 `4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789`）可用，配方走 `kind: glibc`；启动前要 `unset LD_PRELOAD`（同 blender 组件）。Termux 版预编译包缺 NDK r29 的 libc++，起不来。whisper.cpp 能本机编（2 分钟），但市场不收自编二进制，不走。
- **识别**：Whisper small int8（HF `csukuangfj/sherpa-onnx-whisper-small` commit `8f3c18b358db4d1f2fc1eae49d75cd20989e4309`，只取 encoder/decoder/tokens 三个文件约 375 MB）中英混合准确；4 线程 1 分钟音频约 26 秒。Whisper 一次只收 30 秒，要用 ffmpeg 切块再按偏移合成 SRT（需要一个包装脚本）。Paraformer small 很快但许可证为空，Zipformer CTC 小模型许可证没确认，都不能直接用。
- **朗读**：MeloTTS zh_en（`vits-melo-tts-zh_en.tar.bz2`，167,006,755 B，sha256 `e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514`，MIT）音质好，回识别一字不差。espeak 中文错字多。
- **建议形态**：模型别在安装时一次下完，首次用到识别 / 朗读时经用户同意再分别下载、校验 sha256；HuggingFace 国内连不上，要有镜像兜底（如 hf-mirror.com），在说明里照实写测过哪种网络。录音由用户在系统录音机录好后分享进 cccodroid，App 不用改。

#### `android-build`：在手机上用 Gradle 构建安卓应用

2026-10-19 实测（Gradle 9.8.1 / JDK 21 / AGP 9.4.1 / compileSdk 36）：

- 最小 Kotlin 工程能出 debug APK、`apksigner` 验签通过、装到本机能打开；缓存热后重构建约 7 秒，首次约 7 分钟（下依赖）。JVM `-Xmx2048m` 够用。
- AGP 从 Maven 下的 aapt2 是 x86 的，要在 `gradle.properties` 写 `android.aapt2FromMavenOverride=/data/data/cc.codroid/files/usr/bin/aapt2`。构建日志会有大量 `No package ID 7f found` 报错但不影响小工程，**大一点的工程还要再测**。
- **SDK（android.jar、build-tools）按谷歌许可不能随组件分发**：组件只能带 Gradle 和一个引导脚本，让用户自己在终端跑 `sdkmanager`、亲手接受许可（约 300 MB）。
- 安装：有 Shizuku 时 `priv cp` 到 `/data/local/tmp` 再 `pm install`。没有 Shizuku 的安装方式需要 App 配合，做的人请在 issue 里提，维护者来改 App。

#### `x86-vm`：x86_64 虚拟机

能跑：qemu-system-x86-64-headless 11.1.2 + Alpine virt ISO，串口登录、端口转发、SSH 都通。但装后 409 MB + 66 MB ISO，启动约 37 秒，速度约本机的 1/4。维护者判断不值得，真有需要的人可以接手。

### 已收录为组件

下面这些原来在清单里，2026-11 已经做成组件（配方在本仓库，装后自带 skill）：

- `gis-lite`（#90）：PROJ + GEOS + SpatiaLite。坐标转换/投影、几何运算、SQLite 空间扩展；不依赖 libicu。
- `gis`（#85）：GDAL 3.13。栅格/矢量格式转换、坐标转换；需要工具包 devkit-2026.11.21 或更新（libicu 79.1）。
- `kiwix`（#84）：kiwix-tools 3.8.2。离线 ZIM 知识库服务与检索；需要 devkit-2026.11.21 或更新。

### 只有设想、没实测的

| id | 内容 | 要先弄清的 |
|---|---|---|
| `manim` | 数学 / 科普动画直出 MP4 | postinst 会不会现场 pip 装依赖；中文 `Text` 的字体 |
| `tunnel` | 把本机网页临时公开成链接（cloudflared 快速隧道 + caddy） | 国内能不能连上；只公开指定目录、绝不暴露网关端口；**常驻进程**在一轮对话结束、App 退到后台后能不能活 |
| `databases` | PostgreSQL + Valkey 本机服务 | 同上的常驻进程问题；数据目录放 `~/.cccodroid/databases/` |
| `photo-tools` | libvips、exiftool、libraw、potrace、G'MIC | 和底座 ImageMagick 的分工；分享前去 GPS |
| `math` | Maxima、PARI/GP、gnuplot、Z3 + SymPy（配方 `pip`） | gnuplot 中文标题 |
| `backup` | restic，后端借 `rclone` 组件 | 密码只让用户自己输 |
| `ml-onnx` | onnxruntime + OpenCV 端上推理 | 先量体积；模型许可证要能再分发 |
| `video-edit` | MLT（melt）无头剪辑 | 比直接写 ffmpeg 好在哪；体积 |
| `dotnet` | .NET SDK（`linux-arm64`） | **Termux `main`/`glibc` 仓库里目前没有 `dotnet`（`pkg install` 不可用）**；若做成组件需走 `kind: "glibc"` + `fetch`（`extract`）拉取微软官方 `linux-arm64` 归档，先评估解包体积、ICU 依赖与 `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT` / 许可证 |
| `docsearch` | 在 PDF 等文档里全文搜索：pdfgrep + ripgrep-all（rga） | rga 是 AGPL-3.0-or-later；和已有的 `pdf-tools`（已含 poppler、qpdf）怎么分工，别重复打包 |
| `recoll` | Recoll 全文索引，中文走 CJK n-gram | Termux 包只有 `recollindex`，没有查询命令，要用 recoll-python 写一个查询包装脚本 |
| `tiddlywiki` | TiddlyWiki 个人笔记维基（npm，约 37 MB） | 配方走 npm，要钉版本和完整性哈希 |

常驻服务类（tunnel、databases）如果证明进程活不下来，需要 App 提供「后台服务」支持，请在 issue 里提，别自己改 App。

### 看过、决定不收的

| 想法 | 理由 |
|---|---|
| `ebook`（calibre） | 实测装后 705 MB；epub→PDF 在无头 Qt WebEngine 下输出 0 字节；postinst 现场 pip 编 C 扩展 |
| `vector-art`（Inkscape）、`score-render`（MuseScore） | GUI 全家桶体积大，无头运行风险同 calibre；已有 rsvg / typst、lilypond 可替代 |
| `yt-dlp` | 版权与平台条款问题，不由市场提供；需要的人自己 `pkg install` |
| `ollama` | 和 `llama-cpp` 组件重复 |
| proot 完整发行版、wine / box64 | 和原生运行的路线冲突 |
| 单纯一门编程语言（无配套 skill/工作流） | 普通单包 `pkg install` 就够；高频或共享大库的语言由**工具包可选模块**承载（如 `go`、`node`，以及评估/推进中的 `rust`、`python-tools` 与 `autotools`，见 `cccodroid#205` / `#207` / `#209`），不算组件层。只有当仓库缺失需走 `glibc`+`fetch`（如 `.NET`）或自带明确 skill 与端到端自检时，再评估作为组件收录 |

---

## English

The maintainer **doesn't plan to build these**: if you need one, build it. Everything already tested is written down here to save you time.

**To claim one**, comment on the [wanted-components issue](https://github.com/greyoak111/cccodroid-components/issues/52) so two people don't do the same thing, then follow [CONTRIBUTING.md](../CONTRIBUTING.md). Review works as usual, and a component is listed once it has passed on-device verification. Ideas not on this list are welcome too; open an issue first and say what it's for.

### Tested

#### `speech`: speech-to-text and text-to-speech

Tested 2026-10-21 on cccodroid 0.3.5 / devkit-2026.10.18:

- **Engine**: the sherpa-onnx v1.13.8 **Linux glibc prebuilt** (`sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2`, 28,091,778 B, sha256 `4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789`) works as a `kind: glibc` recipe; `unset LD_PRELOAD` before running it (same as the blender component). The Termux prebuilt needs NDK r29's libc++ and won't start. whisper.cpp builds on the device in 2 minutes, but the market doesn't accept self-built binaries.
- **Recognition**: Whisper small int8 (HF `csukuangfj/sherpa-onnx-whisper-small` at commit `8f3c18b358db4d1f2fc1eae49d75cd20989e4309`; encoder, decoder and tokens only, about 375 MB) handles mixed Chinese/English well; one minute of audio takes about 26 s on 4 threads. Whisper takes 30 s at a time, so a wrapper has to cut with ffmpeg and stitch an SRT with offsets. Paraformer small is fast but has no stated license, and the small Zipformer CTC model's license is unconfirmed, so neither can ship as is.
- **Speech synthesis**: MeloTTS zh_en (`vits-melo-tts-zh_en.tar.bz2`, 167,006,755 B, sha256 `e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514`, MIT) sounds good and transcribes back word for word. espeak's Chinese is poor.
- **Suggested shape**: don't download the models at install time. Fetch each one (recognition or synthesis) the first time it's used, after the user agrees, and check its sha256. HuggingFace is blocked in mainland China, so add a mirror fallback (e.g. hf-mirror.com) and say honestly which networks you tested. Users record with their phone's recorder and share the file into cccodroid; no app change needed.

#### `android-build`: build Android apps with Gradle on the phone

Tested 2026-10-19 (Gradle 9.8.1 / JDK 21 / AGP 9.4.1 / compileSdk 36):

- A minimal Kotlin project builds a debug APK, passes `apksigner verify`, installs and opens on the device. Warm rebuilds take about 7 s; the first build about 7 minutes (dependency downloads). `-Xmx2048m` is enough.
- The aapt2 AGP pulls from Maven is x86; set `android.aapt2FromMavenOverride=/data/data/cc.codroid/files/usr/bin/aapt2` in `gradle.properties`. The log fills with `No package ID 7f found` errors that don't affect a small project; **larger projects still need testing**.
- **Google's license forbids redistributing the SDK** (android.jar, build-tools), so a component can only carry Gradle plus a setup script; the user runs `sdkmanager` in the terminal and accepts the license themselves (about 300 MB).
- Installing: with Shizuku, `priv cp` to `/data/local/tmp`, then `pm install`. Installing without Shizuku needs app support; raise it in the issue and the maintainer will change the app.

#### `x86-vm`: x86_64 virtual machine

It works: qemu-system-x86-64-headless 11.1.2 with the Alpine virt ISO; serial login, port forwarding and SSH all tested. But it's 409 MB installed plus a 66 MB ISO, boots in about 37 s and runs at about a quarter of native speed. The maintainer decided it isn't worth it; take it on if you need it.

### Now components

These were on the list and became components in 2026-11 (recipes live in this repo; each ships a skill):

- `gis-lite` (#90): PROJ + GEOS + SpatiaLite — coordinate transforms/projections, geometry operations and SQLite's spatial extension. Does not need libicu.
- `gis` (#85): GDAL 3.13 — raster/vector format conversion and coordinate transforms. Needs devkit-2026.11.21 or newer (libicu 79.1).
- `kiwix` (#84): kiwix-tools 3.8.2 — offline ZIM knowledge bases and search. Needs devkit-2026.11.21 or newer.

### Ideas, not yet tested

| id | What | Find out first |
|---|---|---|
| `manim` | Math / explainer animations straight to MP4 | Whether postinst pip-installs dependencies; fonts for Chinese `Text` |
| `tunnel` | Share a local web page via a temporary public link (cloudflared quick tunnel + caddy) | Whether it connects from mainland China; publish only the chosen folder, never the gateway port; whether a **long-running process** survives the end of a turn and the app going to the background |
| `databases` | Local PostgreSQL + Valkey | The same long-running-process question; data under `~/.cccodroid/databases/` |
| `photo-tools` | libvips, exiftool, libraw, potrace, G'MIC | Division of labour with ImageMagick in the base; strip GPS before sharing |
| `math` | Maxima, PARI/GP, gnuplot, Z3 + SymPy (recipe `pip`) | Chinese titles in gnuplot |
| `backup` | restic, with the `rclone` component as a backend | Only the user types passwords |
| `ml-onnx` | onnxruntime + OpenCV on-device inference | Measure the size first; model licenses must allow redistribution |
| `video-edit` | MLT (melt) headless editing | What it does better than plain ffmpeg; size |
| `dotnet` | .NET SDK (`linux-arm64`) | **Not available in Termux `main`/`glibc` (`pkg install dotnet` does not exist)**; a component would need `kind: "glibc"` + `fetch` (`extract`) of Microsoft's official `linux-arm64` tarball — evaluate unpacked size, ICU dependency, and license first |
| `docsearch` | Full-text search inside PDFs and other documents: pdfgrep + ripgrep-all (rga) | rga is AGPL-3.0-or-later; split the work with the existing `pdf-tools` (which already has poppler and qpdf) instead of packaging them twice |
| `recoll` | Recoll full-text indexing, with CJK n-grams for Chinese | The Termux package only has `recollindex`, no query command; a query wrapper has to be written with recoll-python |
| `tiddlywiki` | TiddlyWiki personal notes wiki (npm, about 37 MB) | npm recipe; pin the version and integrity hash |

If long-running services (tunnel, databases) turn out not to survive, the app needs "background service" support. Raise it in the issue rather than changing the app yourself.

### Considered and declined

| Idea | Why |
|---|---|
| `ebook` (calibre) | Measured 705 MB installed; epub→PDF produces 0 bytes under headless Qt WebEngine; postinst compiles C extensions with pip |
| `vector-art` (Inkscape), `score-render` (MuseScore) | Large GUI stacks with the same headless risk as calibre; rsvg / typst and lilypond already cover the need |
| `yt-dlp` | Copyright and platform terms; not offered by the market, `pkg install` it yourself |
| `ollama` | Duplicates the `llama-cpp` component |
| Full proot distros, wine / box64 | Conflict with running natively |
| A bare programming language (no skill/workflow) | `pkg install` is enough for plain single packages; high-frequency / heavy shared-library languages live in **devkit optional modules** (`go`, `node`, and `rust` / `python-tools` / `autotools`, see `cccodroid#205` / `#207` / `#209`) rather than the component layer. Only consider a component when Termux lacks it (e.g. `glibc` + `fetch` for `.NET`) or it brings a clear skill + end-to-end selftest |
