---
name: math-min
description: 本机数学小工具（cccodroid 组件）：qalc 精确计算与单位换算、PARI/GP 数论和代数、GNU units 单位换算、gnuplot 无头出 PNG/SVG。用户要算题、验证公式、做数学图时使用。
---

# 数学小工具

四个命令行工具，装在本组件里：

- `qalc`（Qalculate! 5.13.1）——带单位、分数、符号的日常计算
- `gp`（PARI/GP 2.19.0）——数论、代数、矩阵
- `units`（GNU units 2.27）——单位换算
- `gnuplot` 6.0.6——无头出图（PNG/SVG），不需要屏幕

## 先自检

```sh
math-min-selftest
```

最后一行应为 `===== 总结 ===== qalc=OK pari=OK units=OK gnuplot=OK png=PASS`，约 2 秒。它在 `$TMPDIR` 算几道题、画一张小图，不碰用户文件、不联网。

## 运行链路

```
math-min-selftest   本组件（$PREFIX/bin）
  ├─ qalc           $PREFIX/bin/qalc（本组件）
  ├─ gp             $PREFIX/bin/gp（本组件，PARI/GP）
  ├─ units          $PREFIX/bin/units（本组件）
  └─ gnuplot        $PREFIX/bin/gnuplot（本组件，带 cairo/gd）
```

`gnuplot` 用 `pngcairo`/`svgcairo` 终端即可无头输出；不要设 `terminal qt`、`x11`，本机没有显示服务。

## 常用

### qalc

```sh
qalc -t '2^100'                         # 精确大整数
qalc -t '1 mile + 1 km'                 # 带单位
qalc -t '5/6 + 7/8'                     # 分数
qalc -t 'sin(pi/6)'                     # 三角函数
qalc -t 'solve(x^2 - 5x + 6 = 0)'       # 解方程（按 qalc 支持范围）
qalc -t '100 USD to CNY'                # 汇率（需联网更新，离线用缓存）
```

- `-t` 只输出结果，适合接脚本；不加会进交互模式。
- 单位写法用空格或 `*`；结果里会带单位，需要纯数字就自己截。

### PARI/GP

```sh
echo 'print(isprime(2^61-1))' | gp -q
echo 'print(factor(2^32+1))' | gp -q
echo 'print(matdet([1,2;3,4]))' | gp -q
echo 'print(prime(100))' | gp -q
gp -q <<'GP'
print(sum(i=1, 100, i^2))
GP
```

- 非交互用 `gp -q` 从 stdin 读命令；`print()` 才会把值打出来。
- 大整数默认精确，不会丢精度；复杂度高的运算注意手机内存。

### units

```sh
units -t '1 mile' 'km'
units -t '100 km/h' 'm/s'
units -t '1 GiB' 'MB'
units -t 'tempC(25)' 'tempF'          # 温度用函数写法
units -t '1 m' 'ft'
```

- `-t` 只输出数值；没有 `-t` 会显示换算等式。
- 单位名区分大小写（`m` 米，`M` 兆，`B` 字节）。

### gnuplot

```sh
gnuplot -e "set terminal pngcairo size 800,600; set output 'plot.png'; plot sin(x)"
gnuplot -e "set terminal svg size 800,600; set output 'plot.svg'; plot x*x"
```

脚本文件：

```gnuplot
set terminal pngcairo size 800,600
set output 'hist.png'
set style data histograms
set boxwidth 0.6
plot 'data.dat' using 2:xtic(1) title 'count'
```

- 无头运行不需要 `DISPLAY`；不要用 `set terminal qt`。
- 中文标签需要字体支持：先 `set fontpath '/system/fonts'`，再用 `set term pngcairo font 'NotoSansCJK-Regular.ttc,12'`；字体名不对会退回默认字体，不是画图失败。
- 想看图，生成 PNG 后用文件查看器打开，不要在终端里开交互窗口。

## 常见坑

- **qalc 汇率会联网**：`100 USD to CNY` 需要下载汇率；离线时用 `qalc -t '100 USD to CNY'` 可能用缓存或报错，不要把汇率当实时数据。
- **PARI 的 `print` 不是可选**：只写表达式不会输出，脚本里务必 `print(...)`。
- **units 的 `-t` 与温度**：温度是仿射变换，必须写 `tempC(25)`，不能写 `25 tempC`。
- **gnuplot 不是绘图库替代品**：复杂统计图优先 `matplotlib`（sci-python 组件）；gnuplot 胜在轻、无 Python 依赖。
- **大计算量**：`gp` 的因式分解、`qalc` 的符号求解都可能长时间占满一个核；先用小参数验证，再放大。
