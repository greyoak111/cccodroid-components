---
name: speech
description: 语音转写与朗读（sherpa-onnx，cccodroid 组件）：把录音/音频转成中文或英文文字、SRT 字幕、JSON；把文字用 MeloTTS 朗读成 WAV。用户要转写、字幕、语音输入、朗读、TTS 时使用。
---

# 语音转写与朗读：sherpa-onnx

本机装了 sherpa-onnx 1.13.8（上游 Linux aarch64 glibc 预编译）和两个按需下载的模型：Whisper small int8（中英混合转写）与 MeloTTS zh_en（中英朗读）。全部离线推理，不上传音频。

## 先自检

```sh
speech selftest
```

最后一行应为 `===== 总结 ===== sherpa-onnx=1.13.8 engine=PASS asr=… tts=…`，约 1 秒（没有模型时）。有模型时会真跑一次短句 TTS 和 1 秒静音 ASR，约 10 秒。它不会下载任何东西。

## 运行链路

```
speech（$PREFIX/bin/speech，本组件的 Python 包装）
  ├─ $PREFIX/glibc/lib/ld-linux-aarch64.so.1（底座 glibc）
  │    └─ --library-path $PREFIX/glibc/lib:$PREFIX/glibc/opt/speech/lib
  │         ├─ sherpa-onnx-offline / -offline-tts（本组件 fetch，$PREFIX/glibc/opt/speech/bin）
  │         ├─ libonnxruntime.so / libsherpa-onnx-*.so（本组件 fetch，同目录 lib/）
  │         ├─ libstdc++.so.6 / libgcc_s.so.1（本组件 roots 的 gcc-libs-glibc，$PREFIX/glibc/lib）
  │         └─ libc.so.6 / libm 等（底座 glibc）
  ├─ ffmpeg / ffprobe（底座「音视频」模块）→ 转 16k 单声道、切块、TTS 转码
  └─ 模型（用户按需下载，不在组件里）
       ~/.cccodroid/speech/models/whisper-small-int8/   ≈ 358 MB
       ~/.cccodroid/speech/models/melo-tts/             ≈ 160 MB
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `speech` | 本组件 | 命令不存在 |
| sherpa-onnx 二进制 | 本组件（上游 fetch） | 包装明确报「引擎缺 …」 |
| glibc 运行时 | 底座 | `ld-linux` 找不到，`speech` 直接报错 |
| `libstdc++.so.6` | 本组件的 `gcc-libs-glibc` | 引擎 `CANNOT LINK`；不会悄悄退回别的模型 |
| `ffmpeg` / `ffprobe` | 底座 | 转写/转码失败，报错 |
| 模型 | 用户按需下载 | 命令报「模型没装：先运行 speech setup …」；不会自动下载 |
| 网络 | 只在 `speech setup` 时 | 识别/朗读全程离线 |

## 模型下载（大文件，先问用户）

模型不随组件走。**下载前必须告诉用户大小、等用户同意**，再加 `--yes`：

```sh
speech setup asr --yes     # Whisper small int8，约 358 MB
speech setup tts --yes     # MeloTTS zh_en，约 160 MB
speech models              # 看装没装、占多大
```

- ASR 来自 HuggingFace 的 `csukuangfj/sherpa-onnx-whisper-small`（commit `8f3c18b3…`），三个文件都核对 sha256；默认先连 huggingface.co，失败自动换 `hf-mirror.com`。也可以用 `--endpoint` 指定别的 HF 镜像。
- TTS 来自 sherpa-onnx 的 GitHub Release `tts-models/vits-melo-tts-zh_en.tar.bz2`，核对 sha256 后解开。
- 模型许可证：Whisper 为 MIT，MeloTTS 为 MIT；组件本体 Apache-2.0。
- 禁止把密码/令牌类东西放进模型目录；这里只放模型。

## 转写

```sh
speech asr recording.m4a                      # 纯文本（自动判断语言）
speech asr recording.m4a --language zh        # 指定中文
speech asr recording.mp4 -o subtitles.srt     # 按后缀出 SRT
speech asr recording.wav --format json        # 带 start/end 的 JSON
```

- 输入可以是 ffmpeg 认识的任何音频/视频；包装先转 16k 单声道 WAV。
- 超过 30 秒的音频会按 30 秒切块（Whisper 单次窗口），每块单独识别，时间戳加上偏移；`segment_timestamps` 用来拼 SRT。
- 切块可能在词中间断开；对字幕要求高时，先自己按静音切，或把 `--chunk-seconds` 调小（如 20）。
- `--threads` 默认 4；设备有 8 核，识别是 CPU 推理，不占 GPU。
- 实测（2026-11-11，HONOR Magic V6）：6.6 秒英文样本 4.6 秒；66 秒样本 34 秒，15 段 SRT。1 分钟音频约 26–35 秒。
- 没有麦克风采集接口：录音由用户用系统录音机录好，再分享/拷进 cccodroid。

## 朗读

```sh
speech say "你好，这是语音合成测试。" -o hello.wav
speech say "Mixed 中文 and English." -o hello.mp3    # 非 wav 会走 ffmpeg 转码
```

- MeloTTS zh_en 只有一个女声（speaker 0），中英混合；`--threads` 默认 2。
- 实测 2.45 秒音频约 7.3 秒（RTF≈1.8），比识别慢；长文本请分句合成再拼。
- 输出 WAV 是 22.05 kHz 单声道；要别的格式用 `-o *.mp3` 或事后 ffmpeg。

## 常见坑

- **模型没装不是组件坏了**：`speech models` 显示 MISSING 就是还没下载；不要去找别的模型路径，也不要从不明来源下模型。
- **不要替用户同意下载**：358 MB / 160 MB 的下载必须先说清楚；国内网络 HuggingFace 可能连不上，包装会自动试 hf-mirror，仍失败就如实告诉用户。
- **glibc 两套运行时的老问题**：引擎必须经 `$PREFIX/glibc/lib/ld-linux-aarch64.so.1` 启动；不要给它加 `LD_PRELOAD` 或 bionic 的 `$PREFIX/lib` 到 `--library-path`，否则会出 `version 'LIBC' not found` 一类错误。
- **首次识别慢**：每块都要加载一次模型（约 2 秒）；长音频的耗时是“模型加载 + 推理”叠加，不是卡死。
- **SRT 时间戳**来自 Whisper 的 segment timestamps，不是逐字对齐；需要逐字时间轴时另做 forced alignment，本组件不带。
