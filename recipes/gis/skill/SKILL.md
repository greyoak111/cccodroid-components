---
name: gis
description: GDAL 地理数据命令行（cccodroid 组件）：栅格/矢量格式转换、坐标系转换、裁剪重投影、读写 GeoTIFF / GeoJSON / Shapefile / PostGIS。用户要处理地理数据、看栅格元数据、做 gdalwarp / ogr2ogr 时使用。不含 GCJ-02 火星坐标纠正。
---

# GIS：GDAL 3.13

本机装了 Termux 官方仓库的 GDAL 3.13.3 命令行：`gdalinfo`、`gdal_translate`、`gdalwarp`、
`gdaltransform`、`gdalsrsinfo`、`ogrinfo`、`ogr2ogr`，以及各格式驱动和 PROJ 数据。

**它要底座 devkit-2026.11.21 或更新的工具包**（libicu 79.1）。旧底座的组件不匹配，升级 cccodroid 后再装。

如果只需要坐标转换、几何运算、SQLite 空间扩展，装更轻的 `gis-lite` 就够；两边共用 proj / GEOS / SpatiaLite 的包。

## 先自检

```sh
gis-selftest
```

最后一行应为 `===== 总结 ===== GDAL 3.13.3 raster=PASS transform=PASS vector=PASS`，约 2 秒。
它在 `$TMPDIR` 写一个 3×2 的 ASCII 栅格，`gdal_translate` 转 GeoTIFF 再 `gdalinfo`；`gdaltransform` 做
EPSG:4326→3857；`ogrinfo` 读一个 GeoJSON。不联网、不写用户文件。

## 运行链路

```
gdalinfo / gdal_translate / gdalwarp / gdaltransform / gdalsrsinfo / ogrinfo / ogr2ogr
  └─ $PREFIX/bin/<命令>          本组件（Termux main 的 gdal 3.13.3-2，前缀已等长改写）
       ├─ libgdal.so             本组件
       ├─ 格式驱动 + share/gdal  本组件（GDAL_DATA 编译进去的路径）
       ├─ PROJ（libproj + proj.db）      本组件（gdal 依赖 proj）
       ├─ xerces-c → libicu*.so.79      **底座**（devkit-2026.11.21+）
       ├─ libpq（PostGIS 驱动用，不含服务器）  本组件
       └─ libcurl / libsqlite / libpng / libtiff / libjpeg…  本组件或底座

输入输出数据由用户提供，组件不碰用户目录。
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `libgdal` 与格式驱动 | 本组件 | `CANNOT LINK EXECUTABLE` 或驱动列表缺项 |
| `libicu 79.1` | **底座** devkit-2026.11.21+ | 旧底座报 `libicuuc.so.79 not found`，**明确失败，不会降级** |
| PROJ 数据（`proj.db`） | 本组件 | 坐标转换报 `Cannot find proj.db` |
| GDAL 数据（`share/gdal`） | 本组件 | 部分驱动/坐标系警告，通常不致命 |
| 输入/输出文件 | 用户 | 命令报打不开文件 |

## 常用

```sh
# 看元数据
gdalinfo dem.tif
gdalsrsinfo -o proj4 dem.tif

# 格式转换 / 重投影 / 裁剪
gdal_translate -of COG in.tif out.tif
gdalwarp -t_srs EPSG:3857 in.tif out_mercator.tif
gdalwarp -te 116.0 39.5 116.8 40.2 in.tif clipped.tif

# 矢量
ogrinfo -so -al data.geojson
ogr2ogr -f GeoJSON out.geojson in.shp
ogr2ogr -t_srs EPSG:3857 out.gpkg in.geojson

# 坐标点转换（stdin：经度 纬度）
echo "116.4 39.9" | gdaltransform -s_srs EPSG:4326 -t_srs EPSG:3857
```

- 中间文件和输出写到用户指定的目录（例如 `$HOME` 或工作区），不要写进 `$PREFIX`。
- 大栅格先 `gdalinfo` 看尺寸，再用 `-te` / `-tr` 控制输出大小，避免把手机存储写满。
- 写文件前先确认目标路径不存在或用户同意覆盖。

## 常见坑

- **GCJ-02 / BD-09 不归 GDAL 管**：火星坐标是国内地图厂商的加密偏移，PROJ/GDAL 只有官方基准。
  用它做国内地图配准会差几百米；不要声称能“纠正火星坐标”。
- **旧底座不能跑**：组件依赖底座里的 libicu 79.1。`CANNOT LINK EXECUTABLE … libicuuc.so.79` 就是工具包太旧，
  让用户升级 cccodroid 后重装，不要去软链 78。
- **`-t_srs` 与 `-s_srs` 不要混**：输入没有坐标系时 `gdalwarp` 会报错；先 `gdalsrsinfo` 或 `gdalinfo` 看有没有 CRS，
  没有就用 `gdal_translate -a_srs` / `gdalwarp -s_srs` 明确指定。
- **Shapefile 是多个文件**：`.shp` / `.shx` / `.dbf` / `.prj` 要一起拿；只给 `.shp` 会缺属性或坐标系。
- **PostGIS 驱动存在但没有服务器**：本组件只带 `libpq`，不会在本机起 PostgreSQL；连接串里的服务器要用户自己提供。
- **内存**：大栅格 `gdalwarp` 可能吃满内存；用 `-wm 256` 限制缓存，或分块处理。
