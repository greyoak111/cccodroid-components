---
name: photo-min
description: 本机照片小工具（cccodroid 组件）：exiv2 读写 EXIF/IPTC/XMP、清除 GPS；G'MIC 命令行滤镜与批量处理；potrace 位图描成 SVG；zbarimg 识别二维码/条码。用户要整理照片隐私、批处理图片、把 logo 转矢量、扫图里的码时使用。
---

# 照片小工具：exiv2 + G'MIC + potrace + zbar

底座已有 ImageMagick（`magick`），本组件补的是它不擅长的四件事：

- `exiv2` 0.28.9——读、改、删 EXIF/IPTC/XMP，尤其是 GPS
- `gmic` 4.0.7——命令行滤镜、批量处理、格式转换
- `potrace` 1.16——黑白位图描成 SVG 矢量
- `zbarimg` 0.23.95——识别图片里的二维码和条码

都不联网、不常驻；G'MIC 和 zbar 不需要屏幕。

## 先自检

```sh
photo-min-selftest
```

最后一行应为 `===== 总结 ===== exiv2=OK gmic=OK potrace=OK zbar=OK exif=PASS svg=PASS`，约 3 秒。它在 `$TMPDIR` 造一张 8×8 的 PGM，依次过 G'MIC、exiv2、potrace、zbarimg，不碰用户照片。

## 运行链路

```
photo-min-selftest  本组件（$PREFIX/bin）
  ├─ exiv2          $PREFIX/bin/exiv2（本组件）
  ├─ gmic           $PREFIX/bin/gmic（本组件）
  ├─ potrace        $PREFIX/bin/potrace（本组件）
  └─ zbarimg        $PREFIX/bin/zbarimg（本组件，运行时要底座 ImageMagick）
```

## 常用

### exiv2：元数据

```sh
exiv2 photo.jpg                          # 摘要
exiv2 -pa photo.jpg                      # 全部元数据（EXIF/IPTC/XMP）
exiv2 -K Exif.Image.Artist -P v photo.jpg
exiv2 -M"set Exif.Image.Artist 我的名字" photo.jpg
exiv2 -M"del Exif.GPSInfo" photo.jpg     # 删掉整组 GPS 信息
exiv2 -d a photo.jpg                     # 删除全部元数据（先备份！）
exiv2 -r '%Y%m%d-%H%M%S_:basename:' *.jpg # 按拍摄时间批量改名
```

- 改元数据是原地写；先复制一份再用。
- 删 GPS 只删 `Exif.GPSInfo`；有些图还有 XMP 里的位置字段，用 `exiv2 -pa` 搜 `GPS`/`Location` 再决定。
- HEIC/AVIF 的元数据支持取决于编译选项；读不出就换 JPEG 原图。

### G'MIC：滤镜与批处理

```sh
gmic input.jpg -blur 2 -output out.jpg
gmic input.jpg -resize 1600,1600 -output small.jpg
gmic input.jpg -rotate 90 -output rotated.jpg
gmic input.jpg -fx_adjust_colors 1,1,1 -output adjusted.jpg
gmic input.jpg -o out.png
gmic -h                                  # 看全部命令
gmic -h blur                             # 看某个命令的参数
```

- 输入输出按扩展名认格式；`-v -1` 关掉进度噪音，`-v 0` 只留错误。
- 批量用 shell 循环；G'MIC 不是文件管理器，不要一次传几百张到内存。
- 滤镜名和参数版本相关，脚本里写死前先 `gmic -h <命令>` 确认。

### potrace：位图→SVG

```sh
# 先把图片转成黑白 PBM（阈值按图调）
gmic logo.png -threshold 50% -output logo.pbm
potrace -s -o logo.svg logo.pbm
potrace -b pdf -o logo.pdf logo.pbm
```

- potrace 只认黑白位图；彩图/灰度要先二值化。阈值不对会丢细节。
- 适合 logo、印章、线稿；照片描线效果通常很差。
- `-s` 输出 SVG，`-b pdf`/`-b eps` 输出其他矢量格式。

### zbarimg：二维码/条码

```sh
zbarimg --nodisplay qr.png
zbarimg -q --nodisplay photo.jpg
zbarimg --nodisplay --raw qr.png         # 只输出内容
```

- 退出码：0 = 找到并解码；4 = 图里没有条码（正常）；其他 = 读图失败。
- 无屏幕环境一定加 `--nodisplay`，否则会尝试开窗口。
- 支持 QR、EAN/UPC、Code 128/39、DataBar 等；模糊、反光、低对比度会识别失败，先用 ImageMagick/G'MIC 放大或增强对比度再试。

### 和底座 ImageMagick 的分工

- 格式转换、缩放、裁剪、拼图：优先 `magick`（底座已有）。
- 元数据、批量滤镜、描线、条码：用本组件。
- 不要重复装 ghostscript/librsvg 等格式插件：底座 ImageMagick 已经带了常用 delegate。

## 常见坑

- **隐私**：发图前用 `exiv2 -pa` 看一遍；GPS、相机序列号、编辑历史都可能泄露。删元数据前保留原图。
- **G'MIC 的 `-output` 与 `-o` 等价**，但参数里出现空格或中文路径要加引号。
- **potrace 输入不是 PBM** 会直接报错；先用 G'MIC 的 `-threshold` 转。
- **zbarimg 依赖 ImageMagick**：底座升级 ImageMagick 大版本后，组件可能需要重装；遇到 `cannot locate symbol` 先重装组件。
- **不要用 zbarimg 扫敏感码并自动打开链接**：只输出内容给用户看，是否访问由用户决定。
