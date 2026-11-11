---
name: apk-tools
description: 本机 APK 检查工具（cccodroid 组件）：apktool 解码/重建 APK 的资源和 smali，dex2jar 把 classes.dex 转 JAR 交给 Java 反编译工具。用户要检查自己开发或已获授权的 APK 时使用；不用于破解、去校验或重新分发他人应用。
---

# APK 检查工具：apktool + dex2jar

- `apktool` 3.0.3——解码 `AndroidManifest.xml`、资源、`classes*.dex` 为 smali，改完可重建
- `d2j-dex2jar`（dex2jar 2.4）——把 `classes.dex` 转成 JAR，用 `javap` 或其他 Java 反编译器查看

JDK 21、`aapt2`、`d8`、`apksigner` 由底座提供。**不包含 jadx**；要直接看 Java 源码可另装 jadx（约 78 MB）。

## 先自检

```sh
apk-tools-selftest
```

最后一行应为 `===== 总结 ===== apktool=OK dex2jar=OK dex-to-jar=PASS`，约 4 秒。它用底座 `javac` + `d8` 造一个 `classes.dex`，再用 `d2j-dex2jar` 转成 JAR，不读用户 APK、不联网。

## 运行链路

```
apk-tools-selftest  本组件（$PREFIX/bin）
  ├─ apktool        $PREFIX/bin/apktool（本组件，Java）
  ├─ d2j-dex2jar    $PREFIX/bin/d2j-dex2jar（本组件，Java）
  └─ javac/d8/...   底座 JDK 21 + Android 构建工具
```

## 常用

### apktool：解码与重建

```sh
apktool d app.apk -o app-src              # 解码资源、Manifest、smali
apktool d app.apk -s -o app-src           # -s 不解码 dex（只看资源）
apktool d app.apk --no-res -o app-smali   # 只看 smali
# 改 app-src 里的文件
apktool b app-src -o app-rebuilt.apk      # 重建（未签名）
apksigner sign --ks my.keystore --out app-signed.apk app-rebuilt.apk
apksigner verify --print-certs app-signed.apk
```

- 重建后必须重新签名才能安装；调试可用 `keytool -genkeypair` 自建密钥。
- `apktool` 的 `-o` 目录必须先不存在或为空；覆盖前先删旧的，别把用户文件混进去。
- 资源 ID、`resources.arsc` 改动容易导致重建后闪退；只改 Manifest 或 smali 时优先用 `--no-res`/`-s` 缩小范围。

### dex2jar：DEX → JAR

```sh
d2j-dex2jar --output classes.jar classes.dex
d2j-dex2jar --output classes.jar app.apk        # 也接受 APK
javap -classpath classes.jar -p com.example.Main
unzip -l classes.jar                             # 看有哪些类
```

- 只做格式转换，不是反编译；JAR 里的字节码用 `javap -c` 或外部 Java 反编译器看。
- 多 dex 的 APK 用 `unzip app.apk 'classes*.dex'` 后逐个转。
- 转换失败常见于新版 DEX/混淆样本；先确认 `d8` 能正常处理，再判断是工具限制。

## 使用边界

- 只处理**自己开发、自己拥有或已获得明确授权**的 APK。
- 不帮助去掉授权校验、绕过付费、去广告后重新分发、伪造签名或冒充他人应用。
- 检查第三方应用时，先向用户确认来源与用途；只做静态查看，不修改、不重打包分发。
- 重建并安装到设备属于会改变系统的操作，先跟用户确认，再按 `android-build` 组件里的说明安装。

## 常见坑

- **`apktool b` 出来的 APK 未签名**：直接安装会报 `INSTALL_PARSE_FAILED_NO_CERTIFICATES`；用 `apksigner` 签。
- **`apktool` 依赖 `aapt2`**：底座已带；如果报找不到，先跑 `aapt2 version` 确认底座完整。
- **`d2j-dex2jar` 是脚本**：它调用 Java；`JAVA_HOME` 异常时用 `java -version` 排查，不要改脚本里的路径。
- **大 APK 解码很占空间**：先在 `$TMPDIR` 留足空间，别解到 `/sdcard`（共享存储不能建链接、速度也慢）。
- **不要在手机上运行来路不明的 smali**：静态查看即可，重建后安装有风险。
