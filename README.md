# cccodroid-components

[中文](README.zh-CN.md)

Community component recipes for [cccodroid](https://github.com/greyoak111/cccodroid), the Android launcher for Claude Code.

A component is an optional software bundle that you install from cccodroid's Extensions page. Examples include the GitHub CLI, LibreOffice, circuit simulators and local LLM inference. Once installed, Claude inside cccodroid can use it. Each component ships a skill that tells Claude how to use it and what to watch out for.

cccodroid reads this repository since 0.1.10. Preset components such as the browser (Chromium) are still published from the cccodroid repository.

## Components

| id | What it is | Category | Notes | Upstream license |
|---|---|---|---|---|
| `gh` | GitHub CLI: pull requests, issues, releases, Actions | Dev | | MIT |
| `godot` | Godot 4 engine: headless runs, Android APK export | Dev | | MIT |
| `diagrams` | Diagrams from text: Graphviz (flowcharts, structure diagrams) + PlantUML (sequence, class diagrams), to SVG / PNG, with Chinese labels | Dev | | EPL-2.0 AND GPL-3.0-or-later AND GPL-2.0-with-classpath-exception |
| `hugo` | Hugo: static websites from Markdown, with local preview and builds | Dev | | Apache-2.0 |
| `re-tools` | Reverse engineering: rizin for ELF / .so info and disassembly; binwalk for archives and filesystems inside firmware | Dev | | LGPL-3.0-or-later AND MIT |
| `blender` | Headless Blender 4.3: Python-scripted compositing, motion graphics and video output; 3D rendering on the Adreno GPU (Vulkan 1.4) | Media | Downloads the engine on first use: about 267 MB from Debian plus an 11 MB patched Mesa for the GPU (the setup follows [blender-cli-android](https://github.com/greyoak111/blender-cli-android)) | GPL-2.0-or-later |
| `lilypond` | LilyPond: music notation from plain text — publication-grade PDF, plus PNG, SVG and MIDI | Media | | GPL-3.0-or-later |
| `music` | Music production toolchain: MIDI to audio (fluidsynth), SuperCollider synthesis, sox mastering, aubio analysis | Media | Bundles a GM soundfont (31 MB) | LGPL-2.1-or-later AND GPL-3.0-or-later AND GPL-2.0-only AND LicenseRef-GeneralUser-GS-2.0 |
| `libreoffice` | Headless LibreOffice: convert documents, export PDF | Office | | MPL-2.0 AND LGPL-3.0 |
| `pandoc` | Pandoc: convert between Markdown, Word, HTML, EPUB and PDF; PDF via the bundled typst | Office | | GPL-2.0-or-later |
| `pdf-tools` | PDF toolbox: merge, split, rotate, encrypt/decrypt, shrink, extract text, render to images (qpdf, poppler, mutool) | Office | | Apache-2.0 AND GPL-2.0-or-later AND AGPL-3.0-or-later |
| `ocr` | OCR: text from images and scanned PDFs in Simplified Chinese, Traditional Chinese and English, plus searchable PDFs | Office | Language models are downloaded at install | Apache-2.0 AND GPL-2.0-or-later |
| `latex` | LaTeX (Tectonic): .tex to PDF with ctex / xeCJK Chinese and beamer | Office | First compile downloads and caches TeX resources | MIT |
| `llama-cpp` | llama.cpp: local LLM inference | AI | Bring your own model (.gguf) | MIT |
| `openscad` | OpenSCAD: script-based 3D modelling, STL and other exports, with the MCAD library | 3D & CAD | | GPL-2.0-only |
| `octave` | GNU Octave: MATLAB-compatible numerical computing with headless plots (bundles gnuplot) | Science | | GPL-3.0-or-later AND gnuplot |
| `sci-python` | Scientific Python: numpy, scipy, matplotlib, Pillow, pyarrow, all prebuilt | Science | | BSD-3-Clause AND PSF-2.0 AND MIT-CMU AND Apache-2.0 |
| `ngspice` | ngspice: circuit simulation | EDA | | BSD-3-Clause AND LGPL-2.1-only |
| `gnucap` | gnucap: circuit simulation | EDA | | GPL-3.0-or-later |
| `iverilog` | Icarus Verilog: Verilog simulation, waveforms rendered to images | EDA | | GPL-2.0-or-later |
| `yosys` | Yosys: Verilog synthesis | EDA | | ISC |
| `gpu-driver` | Gives command-line programs access to the Adreno GPU: Turnip (Vulkan) + zink (OpenGL / GLES) | GPU | Snapdragon only | MIT |
| `gpu-driver-glibc` | The same for glibc (Linux arm64) programs, with the `lgpu-run` launcher | GPU | Snapdragon only | MIT |
| `gpu-driver-mali` | Gives command-line programs the Mali GPU: the vendor Vulkan / GLES driver via the system loader, no root | GPU | Mali only (Dimensity etc.); Termux programs only, no OpenCL | Apache-2.0 |
| `clvk-glibc` | OpenCL (clvk, on top of Vulkan) for glibc programs | GPU | Snapdragon only; needs `gpu-driver-glibc` | Apache-2.0 |
| `gpu-bench` | GPU info and benchmarks (clinfo / vkmark / clpeak) | GPU | Snapdragon only; needs `gpu-driver` | CC0-1.0 AND GPL-3.0-or-later AND GPL-2.0-or-later |
| `cloudflare` | Cloudflare CLI (wrangler): deploy Workers and Pages, manage R2 / KV / D1, run `wrangler dev` locally | Net | Log in with `cf-login` by pasting a token | (MIT OR Apache-2.0) AND Apache-2.0 |
| `rclone` | rclone: sync and back up local folders, WebDAV, S3, Google Drive and more | Net | | MIT |

Every component in the table has been verified on a real device with the current toolchain (devkit-2026.10.28). Some were tested directly; others inherited a verification from an earlier toolchain (see "Device verification" below). The records are in [`verified.json`](verified.json).

The app won't offer "Snapdragon only" components on devices with other chips. For components with dependencies, the app asks you to install those first and won't let you remove them while something still depends on them.

## Published but not yet verified on a device

The app labels these "not verified on a device". Read the description before installing.

- `openai-bridge` (preview): turns an OpenAI Chat Completions API you're allowed to use into a local Anthropic Messages endpoint, which you then enter under Settings → Provider & model → Custom endpoints. Requests go to the remote service you configure and may cost money; the bridge only listens on the loopback address. After installing, run `openai-bridge configure` in the terminal; before removing it in the app, run `openai-bridge uninstall --yes`. About 107 MiB. Source: [chenshi723/cccodroid-openai-bridge](https://github.com/chenshi723/cccodroid-openai-bridge).
- `bilibili-mcp` (MCP): lets Claude read Bilibili — video info, chapters, comments, subtitles, search, favorites. Read-only. Registered as the MCP server `bilibili` on install (cccodroid 0.6.16+). Subtitles, search and favorites need a login: run `bilibili-mcp setup` in the terminal. Upstream: [XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp) (Apache-2.0).
- `bili-groups` (MCP): lets Claude organize your Bilibili followings — list and create follow groups, move people between groups in bulk. **Changes your account.** Registered as the MCP server `bili-groups` on install (cccodroid 0.6.16+); sign in with `bili-groups login` in the terminal. Scripts by chenshi723, shared in the cccodroid group (Apache-2.0).
- `skia-video` (Media): draws text, shapes, images and keyframe animation frame by frame with Skia, then uses the base ffmpeg to make a video, overlay layers on an existing one, or export PNG stills. About 3 MB.
- `code-quality` (Dev): shellcheck, shfmt and ruff. `code-quality check` is read-only; only `fmt --write` changes files.
- `backup` (Net): restic encrypted backups, age file encryption and rsync, wrapped by `ccbackup`. You create the repository password file yourself; the wrapper never reads it.
- `android-build` (Dev): Gradle 9.9.1, using the base JDK 21, aapt2, d8 and apksigner to build Android projects on the phone. The Android SDK is not included: download the command-line tools yourself, unpack them with `android-build setup-sdk`, and accept the licenses in the terminal. About 128 MB.
- `speech` (AI): sherpa-onnx speech to text (Whisper small) and text to speech (MeloTTS zh/en). Models are downloaded on demand — about 358 MB for recognition and 160 MB for speech — and Claude asks you first.
- `databases` (Dev): a local Valkey key-value store (Redis-compatible), listening on 127.0.0.1 only; `ccdb start / stop / status`. No PostgreSQL yet.
- `data-tools` (Dev): miller (CSV/TSV/JSON), xmlstarlet and xmllint.
- `math-min` (Science): qalc calculator, PARI/GP number theory, GNU units and headless gnuplot. Shares gnuplot with `octave`.
- `photo-min` (Media): exiv2 photo metadata, G'MIC filters, potrace bitmap-to-vector and zbarimg barcode/QR reading.
- `pandas` (Science): pandas 3.1 for tabular data, with its own numpy; does not need `sci-python` (shares numpy and libopenblas with it).
- `apk-tools` (Dev): apktool decode/rebuild and dex2jar, for inspecting your own or authorized APKs. jadx is not included.
- `ml-tflite` (AI): TensorFlow Lite 2.21 CPU inference with its own numpy; bring your own model.
- `minecraft-server` (Other): a native Paper 1.21.11 server; Java 21 comes from the base. The first start downloads the vanilla server from Mojang (about 54 MB) and patches it, which took almost 9 minutes in testing. You must read and accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) yourself. Listens locally by default; LAN play has to be turned on explicitly.
- `qq-bot` (Net): runs Linux QQ + NapCat natively as a OneBot bot that only answers allow-listed conversations and always replies as an AI. The first `setup` downloads from Tencent and NapCat's GitHub Release after you agree — about 307 MB, about 1.1 GB installed. **Disclaimer: this is a community component, not affiliated with or endorsed by Tencent, QQ or NapCat. It drives the QQ client through an unofficial framework, which may breach Tencent's terms; the QQ account you log in with may be restricted, frozen or banned, at your own risk — use a spare account. Replies are AI-generated and you are responsible for everything the bot sends, including following the law, platform rules and group rules. Do not use it for mass registration, account farming, spam, marketing blasts or impersonating people. NapCat is licensed for non-commercial use only. Provided "as is", without warranty of any kind.**

## How it works

- **This repo holds recipes only, no binaries.** A recipe lists Termux package names. CI downloads the official Termux `.deb` files, checks every SHA-256, rewrites the prefix from `com.termux` to `cc.codroid` (same length, byte for byte), and packs the result. A recipe may also declare an upstream artifact with `fetch` (URL plus SHA-256). This is only for artifacts the component needs at runtime that the official repository doesn't have; CI downloads and checks them.
- **One build per toolchain version.** Components contain only what the cccodroid toolchain lacks, so each one is built against every toolchain listed in [`bases.json`](bases.json). The app installs the build that matches the user's toolchain. When cccodroid ships a new toolchain, it gets a line here.
- **Signed index.** CI publishes `components.json` to the `index` release with an ed25519 signature (`components.json.sig`). The app checks it against a built-in public key, so a tampered index or package won't install.
- **Device verification.** `verified.json` lists builds that were installed on a real device, passed their self-test and uninstalled cleanly. Anything not listed shows as "not verified on a device" in the app. After a new toolchain, a build inherits the earlier record if neither the component's packages nor the toolchain packages it relies on have changed. Only builds that actually changed need a new test.
- **Audit.** Every pull request runs the format check (`check-recipes.mjs`). Then `audit.mjs` builds the package for real and checks:
  - missing libraries and script interpreters;
  - files that would overwrite the toolchain, and leftover Termux paths;
  - anything in the skill that a human should look at (tokens, downloads, delete or publish steps, privilege escalation).

  The audit report rates each component as 🟢 read the report, 🟡 read the scripts and skill, or 🔴 review line by line.

## Adding a component

Read the [authoring rules](.claude/skills/component-authoring/SKILL.md), then [CONTRIBUTING.md](CONTRIBUTING.md) and the [recipe format](docs/recipe.md). Looking for something to build? [Wanted components](docs/wanted.md) lists candidates the maintainer won't build alone, with the test results so far; claim one in [#52](https://github.com/greyoak111/cccodroid-components/issues/52). The quickest start is to copy `recipes/gh/`. For larger examples with wrapper scripts, see `recipes/iverilog/` or `recipes/llama-cpp/`.

If an AI assistant writes the component for you, [AGENTS.md](AGENTS.md) at the repository root is written for it.

The market doesn't accept components for reverse proxies, shared or resold accounts, jailbreaking or mass-controlled accounts, and removes any it finds (see "Not accepted" in [CONTRIBUTING.md](CONTRIBUTING.md)). These practices end up hurting ordinary users; cccodroid's position is in [What this project stands against](https://github.com/greyoak111/cccodroid#what-this-project-stands-against).

## Thanks

Thank you, in order of contribution:

- **[CCB-Fox](https://github.com/CCB-Fox)**: contributed [`gpu-driver-mali`](recipes/gpu-driver-mali/) (#46), the first external component. Worked out on a Dimensity 9400 how to use the vendor Mali driver through the system Vulkan loader without root, which is why `needs.gpu: "mali"` exists.
- **[Cosmosophius](https://github.com/Cosmosophius)**: a thorough Dimensity 9300 (Mali-G720) report (#47) that independently confirmed the same approach and measured compute performance, extension support and the dead ends.

GitHub's contributor list only counts commits. Reports and device testing are contributions too, and they're recorded here.

## License

Recipes, scripts and documentation in this repository are Apache-2.0. Packaged software keeps its upstream license, recorded in each recipe.
