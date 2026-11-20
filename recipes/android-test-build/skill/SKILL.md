---
name: android-test-build
description: 在 cccodroid 手机上为自己开发或明确获授权的 Gradle Android 工程构建可并装测试 APK，并检查包名、Manifest 组件和签名时使用。
---

# 安卓测试构建

本组件为 Gradle Android 工程提供独立测试签名和 APK 身份检查。它不会改工程文件、release 签名配置或正式应用，也不会安装 APK。

## 先自检

```sh
android-test-build selftest
```

最后一行应为 `===== 总结 ===== aapt2=OK dex=OK test-sign=OK signature-verify=OK inspect=OK`。它在 `$TMPDIR` 中生成最小 APK 和临时密钥，实测 DEX、aapt2、签名、验签与检查链路，不需要网络、不读取项目或用户密钥。

## 运行链路

```
android-test-build（本组件，$PREFIX/bin，Python 入口）
  ├─ android-build CLI → Gradle（依赖组件提供；wrapper 负责 SDK 与 aapt2 配置）
  ├─ javac / keytool（cccodroid 底座 JDK 21；仅自检生成临时类和测试密钥）
  ├─ aapt2 / d8 / apksigner（底座安卓打包模块；Gradle Android 插件也需要它们）
  ├─ Android SDK（用户安装并自行接受许可；android-build 组件负责引导）
  └─ 本地测试密钥（首次 keygen 生成在 ~/.cccodroid/test-build/，仅测试签名）
```

| 这一环 | 由谁提供 | 缺失时 |
|---|---|---|
| `android-test-build` | 本组件 | 命令不存在 |
| `android-build` / Gradle | 依赖组件提供的 `android-build` 包装与 Gradle | 明确报缺少构建器或构建失败 |
| JDK、aapt2、d8、apksigner | cccodroid 底座 | 自检或构建明确失败 |
| Android SDK 平台和构建工具 | 用户按许可自行安装 | Gradle 明确报告 SDK 缺失 |
| 测试签名密钥 | 用户首次运行 `keygen` 时本地生成 | 签名构建报缺少测试密钥 |

## 用法

1. 先确认工程为你所有或你有明确授权，且工程配置已经使用独立测试 application ID，例如 `cc.example.app.test`。本工具只验证实际 APK 身份，不自动改写 Manifest、Gradle 配置或 application ID。
2. 生成测试密钥：

   ```sh
   android-test-build keygen
   ```

   密钥和口令保存在应用私有目录 `~/.cccodroid/test-build/`，文件权限为 0600。密钥口令由系统随机生成；组件不打印口令或私钥。备份这个目录才能保留同一测试签名的更新能力。不要把它提交到仓库或共享目录。密钥丢失后，旧测试 APK 不能由新密钥签名的包原位更新。

3. 在工程目录构建、签名并检查：

   ```sh
   android-test-build build --project . --application-id cc.example.app.test --sign
   ```

   默认运行 `assembleDebug`。默认从 `app/build/outputs/apk/` 选择唯一 APK，生成旁边的 `*-test-signed.apk`；若有多个 APK，必须用 `--apk` 明确指定。签名输出不会覆盖未签名 APK。

4. 单独检查 APK：

   ```sh
   android-test-build inspect app/build/outputs/apk/debug/app-debug.apk --expected-id cc.example.app.test
   ```

   检查输出含 APK SHA-256、应用包名、组件类名和 apksigner 验证结果。工具调用底座的 `aapt2 dump xmltree` 读取二进制 Manifest，并把组件声明与 APK 中的 DEX 类交叉核验；组件缺失或签名无效时返回失败。

5. 安装由用户自己决定并执行。需要复制到共享存储或调用系统安装器时，先说明目标文件和影响并征得用户同意；本组件不调用 `pm`、Shizuku，也不自动安装。

## 安全边界与常见问题

- 测试密钥不等于改签第三方 APK。本工具只对用户自己构建且明确授权的工程产物签名；不用于绕过授权校验、伪造应用身份或重新分发他人应用。
- 测试 application ID 必须和正式应用不同才能并存。Android 原生组件类仍须能解析到工程中的 Java/Kotlin 类；包名或组件不匹配时检查会失败。
- `keygen` 不覆盖已有密钥。若要换钥匙，先由用户自行备份并移走私有测试状态目录，再重新生成；更换密钥会让已安装的测试版无法原位更新。
- 签名 APK 属于构建产物，可能包含项目代码和资源；分享或发布前先确认其中不含密钥、令牌或私有数据。
- Gradle 第一次构建可能联网下载项目声明的依赖；这由工程的 Gradle 配置决定。运行构建前应检查工程来源与依赖声明。
