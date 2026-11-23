---
name: kiwix
description: Kiwix 离线 ZIM 知识库（cccodroid 组件）：用 kiwix-serve 在设备上开一个只读的离线维基/文档阅读页，kiwix-manage 管理库，kiwix-search 全文检索。用户要把维基百科等 ZIM 放到手机上离线浏览时使用。
---

# Kiwix：离线 ZIM 知识库

本机装了 Termux 官方仓库的 `kiwix-tools 3.8.2`：`kiwix-serve`、`kiwix-manage`、`kiwix-search`，
另带 `kiwix-serve-local`——和 `kiwix-serve` 一样，但默认只监听 `127.0.0.1`。**ZIM 本体不在组件里**，要用户自己下载。

## 先自检

```sh
kiwix-selftest
```

最后一行应为 `===== 总结 ===== kiwix-serve=3.8.2 kiwix-manage=3.8.2 kiwix-search=OK`，约 1 秒。
它只验证三个命令能启动、libkiwix / libzim / libicu 79 能加载——没有可再分发的小 ZIM，所以不打开真实知识库。

## 运行链路

```
kiwix-serve / kiwix-manage / kiwix-search
  └─ $PREFIX/bin/<命令>           本组件（Termux main 的 kiwix-tools 3.8.2，前缀已等长改写）
       ├─ libkiwix.so.14          本组件
       ├─ libzim.so.9             本组件
       └─ libicu*.so.79           **底座**（devkit-2026.11.21 起；旧底座是 78.3）
            其余 libcurl / libmicrohttpd / libxapian / libpugixml / liblzma / libzstd
                                   本组件或底座

kiwix-serve-local
  └─ 本组件的包装脚本 → exec kiwix-serve --address=127.0.0.1 "$@"
  ZIM 文件                         用户自己下载/放到手机上，组件不带
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| 三个 kiwix 命令 | 本组件 | 命令不存在 |
| `libkiwix` / `libzim` | 本组件 | `CANNOT LINK EXECUTABLE` |
| `libicu 79.1` | **底座** devkit-2026.11.21+ | 旧底座（如 2026.10.28 的 78.3）报 `libicuuc.so.79 not found`，**明确失败，不会降级** |
| ZIM 知识库 | 用户自备 | 命令能起，但 `kiwix-serve` 没有内容可服务；不是组件的问题 |

**版本要求**：本组件必须配 devkit-2026.11.21 或更新的工具包。App 按底座匹配构建，正常安装即可；
如果用户从很旧的工具包升级上来，先升级 cccodroid 再装/重装本组件。

## 常用

```sh
# 起一个只监听本机的阅读服务（默认 80 端口，普通用户改 8080）
kiwix-serve-local --port=8080 wikipedia_zh_all_maxi.zim
# 浏览器打开 http://127.0.0.1:8080/

# 多个 ZIM 用 library 管理
kiwix-manage ~/.cccodroid/kiwix/library.xml add wikipedia_zh_all_maxi.zim wiktionary_zh_all.zim
kiwix-serve-local --port=8080 --library ~/.cccodroid/kiwix/library.xml

# 命令行全文检索
kiwix-search wikipedia_zh_all_maxi.zim "空间站"
```

- **始终用 `kiwix-serve-local`**，或自己写 `--address=127.0.0.1`。上游 `kiwix-serve` 默认 `--address=all`，会把无认证的阅读页暴露到局域网。
- 端口用 `--port`，不要用 80（可能没有权限）；不要做端口转发、反代或内网穿透。
- ZIM 下载：用浏览器或 `curl -O https://download.kiwix.org/zim/…`，文件很大（中文维基全量几十 GB，mini/maxi 版本小一些），
  **先告诉用户大小、放哪个目录，得到同意再下**。下载要核对官方索引里的 sha256。
- 库文件默认建议放 `~/.cccodroid/kiwix/`，和用户数据分开。

## 常见坑

- **不要用 `kiwix-serve` 裸命令**：默认监听所有网卡。`kiwix-serve-local` 只是补默认值，用户显式传 `-i` / `--address` 时仍按用户的来。
- **后台进程不保证常驻**：`kiwix-serve` 是前台服务，Claude 这一轮结束后可能被杀。要长时间阅读就让用户在自己的终端里起，或用 `nohup … &` 后告诉用户它随时可能停。
- **ZIM 有版权**：分发的 ZIM 各自带许可证；只下载官方 kiwix.org 上的包，不要把 ZIM 打进组件或再分发。
- **`--library` 和直接给 ZIM 二选一**：混用会让人以为库里的文件都生效了；用库时先 `kiwix-manage … add`。
- **搜索语言**：`kiwix-search` 用的是 ZIM 里的 Xapian 索引；纯文本查询即可，别传正则。
- **不是在线百科**：没有网络抓取、没有自动更新 ZIM；要更新就让用户重新下载。
