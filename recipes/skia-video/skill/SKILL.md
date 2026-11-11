---
name: skia-video
description: 用 Skia 逐帧渲染视频：生成片头/动画/字幕条，或把文字、图形、图片叠加到现有视频上（配合底座 ffmpeg）。用户要做视频叠加、标题卡、逐帧动画、PNG 序列时使用。
---

# Skia 视频帧渲染（skia-video）

组件提供两个命令：

- `skia-video`：解码（可选）→ Skia 逐帧绘制 → ffmpeg 编码，一条命令出 MP4。
- `skia-render`：静帧 PNG/JPEG/WebP、PNG 序列、rawvideo 管道（给 ffmpeg 用）。

底层是 Skia（本组件依赖 Termux 包 `libskiasharp`，Skia m119），ffmpeg 来自底座。
Skia 走 CPU 光栅，不用 GPU。

## 运行链路

```
skia-video（$PREFIX/bin/skia-video，Python 启动器）
  ├─ skia_render.py（本组件，$PREFIX/share/cccodroid/components/skia-video/）
  │    └─ libSkiaSharp.so（本组件依赖的 libskiasharp 包，装在 $PREFIX/lib；
  │         依赖 freetype / libpng / libwebp / libjpeg / zlib / EGL，底座已有）
  ├─ ffmpeg（底座自带，$PREFIX/bin）
  └─ python3（底座自带）
```

- 缺 `libSkiaSharp.so`：`skia-render` 报“找不到 libSkiaSharp.so…”，不会降级。
- 缺 ffmpeg：`skia-video` 报“找不到 ffmpeg”；`skia-render` 的 still / frames / pipe 不需要 ffmpeg。
- 字体：默认用 `/system/fonts/NotoSansCJK-Regular.ttc` 的简体 face；没有就退到 Skia 的
  `sans-serif`。指定 `font` 时若该字体不含汉字，会打警告并退回系统 CJK 字体；想确认走的哪条：
  `skia-render fonts`。
- 硬件编码不是必须的：`--codec h264_mediacodec` 在支持的机型上加速，失败会明确报错；
  不写就用 libx264（任何设备都能用）。

## 先自检

```sh
skia-render selftest
```

最后一行应是 `===== 总结 ===== Skia=… render=PASS png=PASS`，退出码 0 才算组件正常。

## 用法

### 生成视频（无输入）

```sh
skia-video scene.json -o out.mp4 --duration 5
```

- 输出尺寸、帧率取场景里的 `width` / `height` / `fps`；`--duration` 覆盖场景 `duration`。
- 不写 `--duration` 时用场景的 `duration`；两者都没有就报错。

### 叠加到现有视频

```sh
skia-video overlay.json -i input.mp4 -o out.mp4 --duration 10
```

- `input.mp4` 先按场景尺寸缩放：默认 `contain`（保持比例、黑边补齐）；
  `--input-fit cover` 裁切填满，`--input-fit stretch` 拉伸。
- 场景里的 `background` 在叠加模式下**不生效**（视频就是背景），其他图层照常画在上面。
- 音频默认重新编码为 AAC；`--audio copy` 直接复制（源音频编码 mp4 兼容时），
  `--audio none` 不要音频。
- `--start 12 --end 22` 只处理输入的第 12–22 秒；场景时间从 0 开始，
  动画要按整段视频计时就用 `--time-offset 12`。

### 静帧 / PNG 序列

```sh
skia-render still scene.json -t 1.5 -o frame.png
skia-render frames scene.json -o frames/ --duration 5
```

`still` 按扩展名选 PNG / JPEG / WebP；`frames` 默认写 `frame_%06d.png`，可用 `--pattern` 改。

### 查看场景和字体

```sh
skia-render info scene.json
skia-render fonts
```

组件自带一个示例场景，可以直接试：

```sh
skia-render still "$PREFIX/share/cccodroid/components/skia-video/examples/scene.json" -t 2 -o demo.png
skia-video "$PREFIX/share/cccodroid/components/skia-video/examples/scene.json" -o demo.mp4
```

## 场景格式

```json
{
  "width": 1280, "height": 720, "fps": 30, "duration": 5,
  "background": "#0B0F14FF",
  "layers": [
    {"type": "rect", "x": 0, "y": 0, "w": 1280, "h": 120, "radius": 24,
     "fill": {"type": "linear", "from": [0, 0], "to": [1280, 0],
              "stops": [[0, "#FF6B6BFF"], [1, "#4ECDC4FF"]]},
     "stroke": "#FFFFFFFF", "strokeWidth": 4, "opacity": 0.9, "blend": "screen"},
    {"type": "text", "text": "第一行\n第二行", "x": 640, "y": 200,
     "size": 64, "align": "center", "valign": "top", "lineHeight": 80,
     "fill": "#FFFFFFFF"},
    {"type": "circle", "cx": {"keys": [[0, 200], [5, 1080]], "ease": "inOut"},
     "cy": 360, "r": 60, "fill": "#FFD166FF"},
    {"type": "image", "src": "logo.png", "x": 100, "y": 100,
     "w": 200, "h": 200, "fit": "contain", "opacity": 0.85},
    {"type": "path", "d": "M 700 620 C 760 540, 860 700, 920 600",
     "stroke": "#EF476FFF", "strokeWidth": 8, "strokeCap": "round"},
    {"type": "line", "x1": 0, "y1": 700, "x2": 1280, "y2": 700,
     "stroke": "#FFFFFF66", "strokeWidth": 2}
  ]
}
```

图元：`rect`（`radius` 圆角）、`ellipse`（`cx/cy/rx/ry` 或 `r`）、`circle`、`line`、
`path`（SVG `d`，`x/y` 是平移）、`text`、`image`。

通用属性：

- **动画**：任何数字都能写成 `{"keys": [[t, 值], …], "ease": "inOut"}`；
  `ease` 可选 `linear` / `in` / `out` / `inOut` / `inSine` / `outSine` / `inOutSine`。
  颜色也能在关键帧之间插值。
- **变换**：`rotation`（度）、`scale`（数字或 `[sx, sy]`）、`origin: [x, y]`（默认元素中心）。
- **外观**：`opacity`、`blend`（`multiply` / `screen` / `overlay` / `lighten` / `darken` 等，
  见 Skia 的混合模式）、`clip: [x, y, w, h]`、`visible`。
- **描边**：`stroke`、`strokeWidth`、`strokeCap`（butt/round/square）、`strokeJoin`（miter/round/bevel）。
- **颜色**：`#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`、`rgb()` / `rgba()`、常用颜色名。
- **渐变**：`fill` 写成 `{"type": "linear"|"radial", "stops": [[0, 颜色], [1, 颜色]],
  "from"/"to" 或 "center"/"radius", "tile": "clamp"}`。
- **文字**：`font` 是字体家族名（`sans-serif`、`serif`、`monospace` 等）；
  要指定字体文件用 `fontFile`（可配 `fontIndex` 选 TTC 里的 face）。`y` 默认是基线，
  `valign` 可写 `top` / `middle` / `bottom` / `baseline`。

## 常见坑

- **输出尺寸 = 场景尺寸**，不是输入视频尺寸。`skia-video` 会先把输入缩放到场景尺寸；
  想按输入原尺寸输出，把场景 `width/height` 改成和输入一致。
- 叠加模式下场景 `background` 被忽略；没有输入时默认背景是黑色（`#000000FF`）。
- 字体：默认已经选了系统简体中文 face。`font` 家族名匹配到拉丁字体时，含汉字的文本会
  自动退回系统 CJK 字体并打警告；没有逐字回退，emoji 不在支持范围（会显示成方框或空白）。
- `skia-video` 默认**不覆盖**已有输出：加 `--overwrite`。覆盖、删除、长时间渲染前先问用户。
- 大分辨率/长视频：渲染进度打到 stderr（每 30 帧一行）；1080p 用 `--preset veryfast` 或
  `--codec h264_mediacodec` 会快很多。硬件编码各机型支持不同，失败就退回 libx264。
- `--extra` 后面的参数原样传给 ffmpeg，例如 `--extra -b:v 12M`；`--extra` 要放在最后。
- 渲染器没有 TTY 交互；不要写等待回车的命令。
