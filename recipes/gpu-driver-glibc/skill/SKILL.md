---
name: gpu-driver-glibc
description: 让 glibc（Linux arm64）程序用上本机 Adreno GPU：Turnip（glibc 侧，Vulkan 1.3）+ 可选 zink。用户要跑 Debian/glibc 的 Vulkan 或 OpenGL 程序（Blender 之类）、或问 glibc 程序能不能用 GPU 时使用。
---

# GPU（glibc 侧）

给 **glibc 程序**（Debian 包、glibc 构建的二进制）接上本机 Adreno GPU：`lgpu-run` 负责
把 glibc 运行时、Turnip 的 ICD、以及（可选）Mesa/zink 的环境拼对，再经 `ld-linux` 启动程序。

## 先自检

```sh
lgpu-info          # GPU / glibc 运行时 / Turnip / Mesa(zink) / clvk；退出码 0 = Turnip 可用
```

## 运行链路

```
lgpu-run [-z] [-L 目录] <glibc 程序>（bash 包装）
  ├─ 摘掉继承来的 LD_PRELOAD（cccodroid shell 挂的 bionic termux-exec 垫片）
  ├─ VK_ICD_FILENAMES / VK_DRIVER_FILES → glibc 侧 Turnip 的 ICD
  │     （ICD 里的 library_path 打不开时，改写一份到 ~/.cccodroid/gpu-driver/icd/）
  ├─ -z：GALLIUM_DRIVER=zink、EGL_PLATFORM=surfaceless、__EGL_VENDOR_LIBRARY_FILENAMES
  ├─ TU_DEBUG=sysmem（默认）
  └─ $PREFIX/glibc/lib/ld-linux-aarch64.so.1 --library-path <$PREFIX/glibc/lib[:-L 给的目录]> <程序>
       └─ 程序 → libvulkan.so.1（glibc 侧 Vulkan 加载器）→ Turnip（libvulkan_freedreno.so）
                → /dev/kgsl-3d0 → Adreno
          -z 时：程序 → Mesa 的 EGL/GL（**你自己提供**）→ zink → 上面那条 Vulkan 链
```

| 这一环 | 由谁提供 | 在哪 |
|---|---|---|
| `lgpu-run` / `lgpu-info` / `lgpu-cc` | 本组件 | `$PREFIX/bin/` |
| glibc 运行时与 `ld-linux` | 底座的 glibc | `$PREFIX/glibc/lib/` |
| Turnip 与 ICD | 本组件：termux-glibc 仓库的 `mesa-vulkan-icd-freedreno-glibc` | `$PREFIX/glibc/lib/libvulkan_freedreno.so`、`$PREFIX/glibc/share/vulkan/icd.d/freedreno_icd.aarch64.json` |
| Vulkan 加载器、`vulkaninfo`、头文件 | 本组件：`vulkan-icd-loader-glibc` / `vulkan-tools-glibc` / `vulkan-headers-glibc` | `$PREFIX/glibc/` |
| glibc 版 Mesa（EGL/GL/zink） | **不在本组件里**；Blender 组件的 Debian 根里有一份 | 用 `-L` 指过去 |
| OpenCL（clvk） | clvk-glibc 组件 | `$PREFIX/glibc/lib/libOpenCL.so` |

- **别的 glibc 组件也靠这里的 Turnip**：Blender 的 EEVEE、clvk 都是。它们找不到 GPU 时，先查本组件装没装（`lgpu-info`）。
- 这份 Turnip 是本机能走 KGSL 的那份。Debian 包里的 Turnip（`mesa-vulkan-drivers`）在本机枚举不到 GPU，别拿它替换。
- 库路径只放 glibc 目录；`$PREFIX/lib` 是 bionic 的，混进来满屏 `version 'LIBC' not found`。
- **会悄悄降级的地方**：`-z` 时 zink 起不来，Mesa 会退回 llvmpipe（CPU）。GL 渲染器名以 `zink` 开头才是走了 GPU。Vulkan 默认路径不降级：没有 Turnip 时 `vulkaninfo` 直接报错或只列出 llvmpipe。

## 用法

```sh
lgpu-run vulkaninfo --summary              # 看 glibc 侧的 Vulkan 驱动
lgpu-run <你的 glibc 程序> [参数...]        # 默认注入 Turnip ICD
lgpu-run -z <GL 程序>                       # OpenGL/GLES 走 zink（需要 glibc 版 Mesa）
lgpu-run -L /path/debroot/usr/lib/aarch64-linux-gnu <程序>   # 追加库目录（Debian 依赖）
lgpu-run --icd <别的 icd.json> <程序>       # 用你自己那份更新版 Mesa 的 ICD
lgpu-run --vendor <程序>                    # 不注入 ICD
lgpu-run --direct <程序>                    # 不经 ld-linux，直接 exec（脚本、静态程序用）
```

## 在本机编 glibc 程序（要写代码时）

```sh
lgpu-cc hello.c -o hello            # C 直接编；C++ 自动换 clang++
lgpu-cc --setup                     # 只补齐工具链碎片（首次会自动做，约 84MB 下载、核对 SHA256）
lgpu-cc --show hello.c              # 只打印最终命令
./hello                             # 编出来直接跑（解释器已指向 $PREFIX/glibc/lib/ld-linux）
lgpu-run ./hello                    # 要 GPU 就套 lgpu-run
```

原理：本机 clang 是 bionic 的，交叉到 glibc 只差「GCC 的 crtbegin*/crtend*/libgcc」那几件
（就是 libgcc-14-dev 的内容，Termux 官方 glibc 仓库的 `gcc-glibc` 包里），`--setup` 只挑那几百 KB 出来。
头文件/库/链接脚本用 base 里已有的 `glibc` 包，动态链接器指到 `$PREFIX/glibc/lib/ld-linux-aarch64.so.1`。

- **`-L` 可以给多次**，也可以设 `CCODROID_LGPU_LIBS`（冒号分隔）。
- ⚠️ **库目录里不能有 bionic 的路径**（`$PREFIX/lib` 等）：那是 Termux 的 libc，
  混进去会满屏 `version 'LIBC' not found`。lgpu-run 默认只放 glibc 的目录，别手动
  把它污染了 —— 需要别的库用 `-L` 显式加。
- glibc 根默认 `$PREFIX/glibc`（`CCODROID_GLIBC_ROOT` 可覆盖）；解释器是
  `$PREFIX/glibc/lib/ld-linux-aarch64.so.1`。
- 默认 `TU_DEBUG=sysmem`（关 tiling，a7xx/a8xx 更稳）；要改用 `CCODROID_TU_DEBUG=`。

## OpenCL（clvk）

glibc 侧用不了厂商的 OpenCL（那是 bionic 库），要用 **clvk**（OpenCL over Vulkan → Turnip）。
clvk 在 CI 上编（clspv + LLVM + libclc 在手机上是小时级）。怎么装看你是哪种安装：

- **从 cccodroid「扩展」页装的**（市场组件）：再装 **`clvk-glibc`**（OpenCL 组件），自测用它带的 `clvk-info`。
  市场组件里没有下面的 `install-clvk.sh`，两种装法也别混用。
- **手动版**（本仓库 `install.sh` 装的），在本仓库目录下：

  ```sh
  glibc/install-clvk.sh                # 取 libOpenCL.so + clspv，核对 SHA256，装进 $PREFIX/glibc
  glibc/install-clvk.sh --dry-run      # 先看它要做什么
  lgpu-cc glibc/lib/clprobe.c -o clprobe && lgpu-run ./clprobe   # 自测：枚举平台/设备 + 真跑一个向量加 kernel
  ```

本机实测（TB320FC / Adreno 730）：平台 `clvk` / OpenCL 3.0 / 设备 `Turnip Adreno (TM) 725` /
kernel 编译 OK / 向量加 PASS。

装好后 `$PREFIX/glibc/lib/libOpenCL.so` 即 OpenCL 实现（`-lOpenCL` 直接链得上）；clspv 内嵌在库里，
`clCreateProgramWithSource` 直接就能编译 kernel。手动版另有 `$PREFIX/glibc/bin/clspv` 可离线把
OpenCL C 编成 SPIR-V（市场组件不带）。

## 坑

- **`LD_PRELOAD` 必须摘掉**：cccodroid 的 shell 给每个进程挂了 bionic 的 termux-exec 垫片，
  glibc 的 ld.so 会跨 libc 继承它，然后按 glibc 的名字解析它的依赖 → 报
  `.../glibc/lib/libc.so: invalid ELF header`（看着像 glibc 装坏了，其实是这个垫片）。
  `lgpu-run` 会自动摘掉（要保留自己的预载用 `CCODROID_LGPU_PRELOAD`）；手写命令时记得 `env -u LD_PRELOAD`。
- **库路径里绝不能有 bionic 的目录**（`$PREFIX/lib` 等）：符号版本是 `LIBC`/`LIBC_N`，混进去会
  满屏 `version 'LIBC' not found`。
- **厂商的 `libOpenCL.so` 用不了**：那是 bionic 库，glibc 进程加载不了。glibc 侧要 OpenCL 只能走
  clvk（OpenCL over Vulkan，本仓库有 CI 构建）或 Mesa 的 rusticl。
- **zink 需要 glibc 版 Mesa**（组件不带，体积大且各发行版版本不一）：用你已有的
  （例如 blender-cli-android 解出来的 debroot/lfdevs Mesa），`lgpu-info` 会告诉你缺什么。
- 缺 `__EGL_VENDOR_LIBRARY_FILENAMES` 时 EGL 只会报误导性的 `EGL_BAD_PARAMETER`——
  `-z` 会自动找 `share/glvnd/egl_vendor.d/50_mesa.json`。
- Android 上没有 `/dev/dri/*`，所以 `EGL_PLATFORM=surfaceless`（`-z` 默认已设）；
  需要窗口的程序仍然跑不了（没有 X11/Wayland 服务端）。
- 只对高通 Adreno 有效（走 `/dev/kgsl-3d0`）。
- **这里的 Turnip 是 Mesa 24.2，认不出较新的芯片**：实测 Adreno 840（一加 Ace 7 Pro）报
  `device (chip_id = …) is unsupported`，clvk 跟着不可用；同一台机器上 bionic 侧的 `gpu-driver`（Mesa 26）正常。
  遇到这个报错别当成系统限制：有更新的 glibc 版 Mesa 时用 `lgpu-run --icd <它的 icd.json>` 指过去，否则先走 bionic 侧。

## 需要用户同意

- 装/删 glibc Mesa、往 `$PREFIX/glibc` 外写东西：先问。lgpu-run 只往
  `~/.cccodroid/gpu-driver/` 写缓存与修补过的 ICD json。
- `lgpu-cc` 第一次用要从 Termux 官方仓库下载约 84MB（核对 SHA256 后只留几百 KB）：先跟用户说一声。
