---
name: gis-lite
description: 坐标转换/投影（PROJ）、几何运算（GEOS/geosop）、SQLite 空间扩展 SpatiaLite（cccodroid 组件 gis-lite）：用户要在设备上做 EPSG 坐标转换、经纬度投影、几何面积/距离/相交，或在 SQLite 里用 ST_* 空间函数时使用。不含 GDAL，也不处理国内地图的 GCJ-02 偏移。
---

# 地理信息基础：PROJ + GEOS + SpatiaLite

本机装了 Termux 官方仓库的 `proj 9.9.0`、`libgeos 3.15.0`、`libspatialite 5.1.0-3`，
并带一个把底座 `sqlite3` 与 `mod_spatialite` 接起来的入口 `spatialite`。

**这不是 GDAL**：没有 `gdalinfo`、`gdalwarp`、`ogr2ogr`，不能读 GeoTIFF / Shapefile / GeoJSON 全家桶。
需要这些时用 `gis` 组件（如果已装）。

## 先自检

```sh
gis-lite-selftest
```

最后一行应为 `===== 总结 ===== PROJ=OK GEOS=OK SpatiaLite=5.1.0`，约 1 秒。
它做一次 WGS84→UTM 50N 转换、一次 `geosop` 面积计算、一次 `mod_spatialite` 的 `ST_Buffer`/`ST_Area`；
不联网、不写用户文件（临时文件在 `$TMPDIR`，结束即删）。

## 运行链路

```
proj / cs2cs / cct / gie / projinfo
  └─ $PREFIX/bin/<命令>          本组件（Termux main 的 proj 9.9.0，前缀已等长改写成应用路径）
       ├─ libproj.so           本组件 $PREFIX/lib
       ├─ proj.db 等数据        本组件 $PREFIX/share/proj（编译进去的路径就是这里）
       └─ libsqlite3 / libtiff / libcurl   底座（base / cli / media 等模块）

geosop
  ├─ $PREFIX/bin/geosop         本组件（libgeos 3.15.0）
  └─ libgeos.so / libc++_shared.so   本组件 + 底座

spatialite（本组件的包装脚本）
  ├─ $PREFIX/bin/spatialite     本组件 → exec 底座的 $PREFIX/bin/sqlite3 -cmd ".load …/lib/mod_spatialite.so"
  ├─ mod_spatialite.so          本组件（libspatialite）
  └─ libgeos_c / libproj / libfreexl / libxml2 / librttopo   本组件或底座
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `proj` / `cs2cs` / `cct` / `gie` / `projinfo` | 本组件（Termux main） | 命令不存在 |
| `geosop` 与 `libgeos` | 本组件 | 命令不存在或 `CANNOT LINK EXECUTABLE` |
| `sqlite3` | **底座**（本组件不带） | `spatialite` 明确报找不到 `$PREFIX/bin/sqlite3` |
| `mod_spatialite.so` | 本组件 | `spatialite` 的 `.load` 报 `no such file` / `cannot open shared object` |
| PROJ 数据（`proj.db`） | 本组件 `share/proj` | 转换报 `Cannot find proj.db` |

没有静默降级：库或数据缺了就是明确报错，不会退回低精度算法。

## 常用

```sh
# 坐标转换：传统 GIS 顺序（经度 纬度）
echo "116.4 39.9" | proj +proj=utm +zone=50 +datum=WGS84
echo "116.4 39.9" | cs2cs +proj=longlat +datum=WGS84 +to +proj=utm +zone=50 +datum=WGS84

# EPSG 代码（注意 PROJ 按 CRS 定义的轴序输出；拿不准就加 -f "%.8f" 先看两列再判断）
echo "39.9 116.4" | cs2cs EPSG:4326 EPSG:3857

# 几何运算
geosop -a "POLYGON((0 0,0 2,2 2,2 0,0 0))" area
geosop -a "POINT(0 0)" -b "POINT(3 4)" distance
geosop -a "POLYGON((0 0,0 2,2 2,2 0,0 0))" -b "POLYGON((1 1,1 3,3 3,3 1,1 1))" intersection

# SQLite 空间扩展（自动加载 mod_spatialite）
spatialite :memory: "SELECT spatialite_version();"
spatialite my.db "SELECT COUNT(*) FROM spatial_ref_sys;"
spatialite -readonly my.db "SELECT ST_AsText(ST_Point(116.4, 39.9));"
```

- `spatialite` 就是底座 `sqlite3` 加一句 `.load mod_spatialite`，参数完全照 sqlite3 用（`-readonly`、`-cmd`、`.tables` 都可以）。
- 新建空间库时按 SpatiaLite 的流程：`SELECT InitSpatialMetaData();` → 建带几何列的表 → `AddGeometryColumn(...)`。
- `cct` 适合跑 PROJ 管线（`+proj=pipeline …`）；`gie` 跑 PROJ 自带的测试；`projinfo` 查 EPSG 定义。

## 常见坑

- **GCJ-02 / BD-09 不归 PROJ 管**：火星坐标是国内地图厂商的加密偏移，PROJ 只有官方基准（WGS84/CGCS2000 等）。
  拿本组件做国内地图配准会差几百米；不要声称能“纠正火星坐标”。
- **经纬度顺序**：`proj` 的传统接口按「经度 纬度」；`cs2cs EPSG:4326 EPSG:3857` 按 CRS 轴序（EPSG:4326 是纬度在前）。
  结果不对时先检查是不是两列写反了。
- **数据目录**：PROJ 数据在 `$PREFIX/share/proj`，不要改；用户自己的数据放用户指定路径，别写进组件目录。
- **只读优先**：只查询时给 `spatialite` 加 `-readonly`；要写库先确认路径属于用户，别覆盖已有文件。
- **没有服务端口**：本组件全是命令行工具，不起任何网络服务。
- **装的两个组件共用包**：`gis`（GDAL）也带 proj / libgeos / libspatialite 同一批包；两个都装时是同一版本，可共存。
