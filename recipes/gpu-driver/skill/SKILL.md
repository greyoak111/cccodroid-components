---
name: gpu-driver
description: 让命令行程序用上本机 Adreno GPU（Turnip Vulkan 1.4 / Mesa zink OpenGL / 厂商 OpenCL）。用户要在设备上跑 Vulkan 或 OpenGL 程序、GPU 计算（llama.cpp 等）、或问"有没有 GPU / GPU 能不能用"时使用。
---

# GPU（高通 Adreno）

装了本组件后，`gpu-run` 用开源驱动 **Turnip（Vulkan 1.4）** 跑程序；`-z` 再加一层
**zink**，把 OpenGL/GLES 转译到 Vulkan。全部进程级生效，不动系统分区、不需要 root。

## 先自检

```sh
gpu-info            # GPU 型号 / 厂商驱动 / Turnip / zink / 渲染自测；退出码 0 = Turnip 可用
```

## 运行链路

`gpu-run` 不是驱动，是一层 bash 包装：它只设环境变量，然后 `exec` 你的程序。驱动由程序自己的加载器按这些变量去找。

```
gpu-run [-z] [--opencl] <程序>（bionic / Termux 侧的程序）
  ├─ 默认   VK_DRIVER_FILES / VK_ICD_FILENAMES → 本组件的 Turnip ICD
  │         程序 → $PREFIX/lib 里的 Vulkan 加载器 → Turnip（libvulkan_freedreno.so）
  │         → /dev/kgsl-3d0 → Adreno
  ├─ -z     再加 GALLIUM_DRIVER=zink：程序 → Mesa 的 EGL/GL（$PREFIX/lib/libgallium-*.so）
  │         → zink（GL 转 Vulkan）→ 上面那条 Turnip 链
  ├─ --opencl  把 /vendor/lib64/libOpenCL.so 拷进 ~/.cccodroid/gpu-driver/opencl/，
  │            用 LD_LIBRARY_PATH 让程序先加载它 → 高通厂商 OpenCL 驱动
  └─ --vendor  什么都不设 → 系统厂商驱动（Vulkan 1.1 / GLES）
```

| 这一环 | 由谁提供 | 在哪 |
|---|---|---|
| `gpu-run` / `gpu-info` | 本组件 | `$PREFIX/bin/` |
| Turnip（Vulkan 驱动）与 ICD | 本组件：Termux 官方包 `mesa-vulkan-icd-freedreno` | `$PREFIX/lib/libvulkan_freedreno.so`、`$PREFIX/share/vulkan/icd.d/freedreno_icd.aarch64.json` |
| Mesa（EGL/GL + zink） | 本组件：Termux 官方包 `mesa` | `$PREFIX/lib/` |
| `vulkaninfo` | 本组件：`vulkan-tools` | `$PREFIX/bin/` |
| 厂商 OpenCL | 设备自带，`--opencl` 时现拷 | `~/.cccodroid/gpu-driver/opencl/` |
| vkmark、glmark2、clinfo、llama.cpp 这类程序 | **不在本组件里**，要另装或自己编 | — |

- 这些全是 **bionic（Termux 侧）** 的库，**只给 bionic 程序用**。glibc 程序（Debian 包、Blender、workerd）加载不了，要用 **gpu-driver-glibc** 组件。
- 只有链了 `$PREFIX/lib` 里那个加载器的程序才认 `VK_DRIVER_FILES`；链了 `/system/lib64/libvulkan.so` 的程序会无视它、继续用厂商驱动。
- **会悄悄降级的地方**：`-z` 时 zink 起不来，Mesa 会退回 llvmpipe（CPU）照样出图。判断方法：`gpu-run -z` 下 GL 渲染器名应以 `zink` 开头、括号里是 Turnip；是 `llvmpipe` 就是没走 GPU。Vulkan 默认路径不会降级，ICD 找不到会直接报错退出。

## 用法

```sh
gpu-run vkmark                            # Vulkan（Turnip）
gpu-run vulkaninfo --summary              # 看驱动版本
gpu-run llama-cli -m model.gguf -ngl 99   # llama.cpp 的 Vulkan 后端（需 Vulkan ≥ 1.2）
gpu-run -z --surfaceless glmark2-es2 --off-screen   # 离屏 OpenGL
gpu-run --opencl clinfo                   # 厂商 OpenCL（首次会把设备的 libOpenCL.so 拷进 ~）
gpu-run --vendor <程序>                   # 不注入任何东西，用系统厂商驱动
```

- `gpu-run -h` 有全部选项。`--` 之后的参数原样传给程序。
- **组件只带驱动和 `vulkaninfo`**（vulkan-tools）。上面的 vkmark、glmark2、clinfo、llama.cpp 都要自备 ——
  cccodroid 没有 pkg/apt，通常是用工具包里的 clang/cmake 自己编。没有的程序先跟用户说清楚，别假装能跑。
- 默认设 `TU_DEBUG=sysmem`（关 tiling，a7xx/a8xx 更稳）；要调：`CCODROID_TU_DEBUG=…`，
  设成空串则不设。
- zink 的着色器缓存写在 `~/.cccodroid/gpu-driver/cache/shader`（首次渲染慢、之后快；删掉即清）。
- 要判断 GPU 到底有没有在干活：`gpu-run --vendor` 与 `gpu-run` 对比渲染耗时，
  或看 `gpu-info` 里 Turnip 的驱动名是不是 `Turnip …`（`llvmpipe`＝软渲染，没走 GPU）。

## 坑（都踩过）

- **只对高通 Adreno 有效**（走 `/dev/kgsl-3d0`；`/dev/dri` 对应用不可见）。其它 SoC 上 `gpu-info` 会明说。
- **厂商驱动只有 Vulkan 1.1**，比 Turnip 老得多。要 Vulkan 1.2+ 的东西（llama.cpp 的 Vulkan 后端等）必须走默认的 Turnip。
- **系统 loader 不认 `VK_DRIVER_FILES`**：链了 `/system/lib64/libvulkan.so` 的程序得用 HAL 通道（可选载荷，本组件默认没装）。
- **静态链接的程序忽略 `LD_PRELOAD`**；**glibc 程序不要用 HAL 通道**（跨 libc 的 LD_PRELOAD 行为不可预期）。
- zink 必须 `GALLIUM_DRIVER=zink`（gpu-run 已设）。只设 `MESA_LOADER_DRIVER_OVERRIDE` 会**静默退回 llvmpipe**，看起来"能跑"其实没用 GPU。
- 首次跑 `-z` 会编译着色器，慢是正常的；缓存预热后再比较性能。
- Adreno 830 / 骁龙 8 Elite 上 Turnip 可能提交失败（社区已知），用 `--vendor` 兜底。
- Android 16 起 OEM 可能对 GPU ioctl 加白名单，新驱动会被拒（本机 Android 15 无此问题）。
- **有的系统不给普通应用用厂商 OpenCL**（实测一加 Ace 7 Pro / Android 17）：`/vendor/lib64/libOpenCL.so` 只是 ICD 加载器，
  系统里没有 ICD 清单，真正的 `libOpenCL_adreno.so` 又被 linker 命名空间挡住，`gpu-info` 的 OpenCL 段会写「没有平台」、总结 `opencl=-`。
  这不是组件坏了，GPU 计算改走 Vulkan（Turnip）。

## 需要用户同意

- 装 / 卸其它组件、写 `~/.cccodroid/gpu-driver` 之外的位置：先问。
- `--opencl` 只是把设备的 `/vendor/lib64/libOpenCL.so` 拷进 `~/.cccodroid/gpu-driver/opencl/`
  （本机、可删、不改 `$PREFIX` 里任何文件），首次执行前顺带提一句即可。
