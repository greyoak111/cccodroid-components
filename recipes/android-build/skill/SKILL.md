---
name: android-build
description: 在手机上用 Gradle 构建安卓工程（cccodroid 组件）：检查 Java/Gradle/aapt2/SDK，解压用户下载的 command-line tools，跑 assembleDebug/assembleRelease，处理 AGP 的 aapt2 覆盖。用户要在设备上编 APK、改 Gradle 工程、排查安卓构建失败时使用。
---

# 安卓构建：Gradle

本机装了 Gradle 9.9.1（Termux 官方包）。JDK 21、aapt2、d8、apksigner 由底座提供；**Android SDK 不随组件分发**（谷歌许可），要用户自己下载并接受许可。

## 先自检

```sh
android-build selftest
```

最后一行应为 `===== 总结 ===== gradle=OK java=OK build=PASS`，约 7 秒。它在 `$TMPDIR` 建一个纯 Java 临时工程，用 `--offline --no-daemon` 跑 `gradle jar`，确认 Gradle 和 JDK 能工作；不需要 Android SDK，也不联网。

## 运行链路

```
android-build（$PREFIX/bin/android-build，本组件的 Python 包装）
  ├─ gradle     $PREFIX/bin/gradle（本组件，Termux 包，9.9.1）
  ├─ java       $PREFIX/bin/java（底座 openjdk-21）
  ├─ aapt2      $PREFIX/bin/aapt2（底座「安卓打包」模块）
  ├─ d8 / apksigner（底座）
  └─ Android SDK（用户自己装，不在组件里）
       $ANDROID_HOME 默认 ~/.cccodroid/android-sdk
         ├─ cmdline-tools/latest/bin/sdkmanager
         ├─ platforms/android-<N>/android.jar
         └─ build-tools/<ver>/
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `android-build` | 本组件 | 命令不存在 |
| `gradle` | 本组件 | 包装明确报「找不到 gradle」 |
| JDK 21 | 底座 | Gradle 起不来；selftest 失败 |
| `aapt2` / `d8` / `apksigner` | 底座 | Android 构建失败；`doctor` 会标「缺失」 |
| Android SDK | **用户自己** | `doctor` 显示 `sdkmanager 未安装`；`build` 会报 SDK 相关错误 |
| AGP 和依赖 | Gradle 首次构建时从 Maven 下载 | 第一次构建慢（约 7 分钟）；离线构建失败 |

- 组件**不下载 SDK**，也**不替用户接受许可**。`setup-sdk --zip` 只把用户下载的官方 zip 解到 SDK 目录。
- 没有 Shizuku 时，安装 APK 需要用户在系统文件管理器里点开，或按应用里的提示操作；组件不自动装。

## 首次准备（由用户完成）

1. 用户下载 Android 官方的 command-line tools（`commandlinetools-linux-*_latest.zip`，约 150 MB），放到设备上。
2. 解压并检查：

   ```sh
   android-build setup-sdk --zip /sdcard/cccodroid/commandlinetools-linux-*_latest.zip
   ```

3. 用户**自己在 cccodroid 终端**里接受许可并安装 SDK 组件（Claude 没有 TTY，不能代跑）：

   ```sh
   ~/.cccodroid/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses
   ~/.cccodroid/android-sdk/cmdline-tools/latest/bin/sdkmanager \
     "platform-tools" "platforms;android-36" "build-tools;36.0.0"
   ```

4. 回来跑 `android-build doctor`，确认 SDK、platforms、build-tools 都在。

## 构建

```sh
cd <工程目录>
android-build build                       # 默认 assembleDebug
android-build build assembleRelease       # 指定任务
android-build build -- --stacktrace       # 传 Gradle 参数（-- 之后）
```

- 包装会设 `ANDROID_HOME` / `ANDROID_SDK_ROOT`（默认 `~/.cccodroid/android-sdk`），并自动加
  `-Pandroid.aapt2FromMavenOverride=$PREFIX/bin/aapt2`。工程 `gradle.properties` 里已经写了这一项时不覆盖。
- 工程有 `gradlew` 就用 `gradlew`，没有就用组件的 `gradle`。
- 首次构建要下 AGP/Kotlin 依赖，7 分钟左右；缓存热了之后小工程约 7 秒。大工程还没验证。
- 内存不够在工程 `gradle.properties` 写 `org.gradle.jvmargs=-Xmx2048m`，不要盲目加大。

## 安装到本机

- 有 Shizuku：把 APK 放到共享目录（如 `/sdcard/cccodroid/app.apk`），用应用的 `priv` 执行
  `pm install -r /sdcard/cccodroid/app.apk`；先跟用户确认要装。
- 没有 Shizuku：让用户在文件管理器里点开 APK 安装。
- 组件不碰 `pm`，也不自动装。

## 常见坑

- **AGP 从 Maven 拉的 aapt2 是 x86 的**，在 arm64 手机上会失败；包装的 `-Pandroid.aapt2FromMavenOverride` 就是为此。不要删掉它。
- `sdkmanager --licenses` 是交互式命令，必须用户自己在终端跑；不要用 `yes |` 替用户接受许可。
- 构建日志里大量 `No package ID 7f found` 在小工程上可忽略，但大工程要单独验证；不要据此判断构建失败。
- 首次构建必须联网；`--offline` 只用于组件自检的纯 Java 工程，不要给真实 Android 工程加。
- 没有 SDK 时 `build` 的报错可能很长，先跑 `android-build doctor` 看缺哪一层，再决定是装 SDK 还是改工程。
