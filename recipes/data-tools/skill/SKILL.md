---
name: data-tools
description: 本机 CSV/TSV/JSON 与 XML 命令行工具（cccodroid 组件）：miller（mlr）做表格转换、筛选、连接、统计；xmlstarlet 和 xmllint 做 XPath 查询、格式化与校验。用户要清洗导出数据、合并 CSV、查 XML 字段时使用。
---

# 数据工具：miller + xmlstarlet + xmllint

三个命令行工具，装在本组件里：

- `mlr`（miller 6.22.0）——把 CSV/TSV/JSON 当带字段名的流处理
- `xmlstarlet` 1.7.0 —— XML 的 XPath 查询、编辑
- `xmllint`（libxml2-utils 2.15.4）—— XML 格式化、校验、XPath

都不联网，不常驻。

## 先自检

```sh
data-tools-selftest
```

最后一行应为 `===== 总结 ===== miller=OK xmlstarlet=OK xmllint=OK csv=PASS xpath=PASS`，约 1 秒。它在 `$TMPDIR` 造一小段 CSV 和 XML 验证转换与 XPath，不碰用户文件。

## 运行链路

```
data-tools-selftest  本组件（$PREFIX/bin）
  ├─ mlr             $PREFIX/bin/mlr（本组件，Termux main）
  ├─ xmlstarlet      $PREFIX/bin/xmlstarlet（本组件，Termux main，依赖 libxslt）
  └─ xmllint         $PREFIX/bin/xmllint（本组件，libxml2-utils）
```

| 这一环 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| `mlr` / `xmlstarlet` / `xmllint` | 本组件 | 命令不存在 |
| `libxml2` / readline | 底座 | 组件依赖解析失败 |
| `libxslt` | 本组件 | `xmlstarlet` 起不来 |

## 常用

### miller

```sh
mlr --csv head -n 20 data.csv                    # 看前 20 行
mlr --icsv --ojson cat data.csv                  # CSV → JSON（每行一个对象）
mlr --icsv --otsv cat data.csv                   # CSV → TSV
mlr --csv filter '$score > 60' data.csv          # 按字段筛选
mlr --csv sort-by score data.csv                 # 排序（-r 倒序）
mlr --csv cut -f name,score data.csv             # 只留字段
mlr --csv stats1 -a mean,min,max -f score data.csv
mlr --csv join -j id -f a.csv b.csv              # 按 id 连接
```

- 默认分隔符是逗号；TSV 用 `--tsv`，其他分隔符用 `--csv --fs ';'`。
- 字段名里有空格、点或中文时，用 `'${字段 名}'` 引用。
- 大文件是流式的，内存占用低，适合手机。

### xmlstarlet

```sh
xmlstarlet sel -t -v '/root/item/@id' data.xml          # 取属性
xmlstarlet sel -t -v '/root/item' -n data.xml           # 取文本，每行一个
xmlstarlet sel -t -m '/root/item' -v '@id' -o ' ' -v '.' -n data.xml
xmlstarlet ed -u '/root/item[@id="1"]' -v 'new' data.xml > out.xml
xmlstarlet val --well-formed data.xml                   # 只查格式
```

### xmllint

```sh
xmllint --format data.xml > pretty.xml                  # 缩进
xmllint --xpath 'string(/root/item[@id="1"])' data.xml
xmllint --xpath 'count(/root/item)' data.xml; echo
xmllint --noout --schema schema.xsd data.xml            # XSD 校验
```

## 常见坑

- **带命名空间的 XML**：XPath `/root/item` 会查不到。先用 `xmllint --xpath 'local-name(/*)'` 看根节点，或给 xmlstarlet 加 `-N ns=URI` 再用 `/ns:root/ns:item`。不要因为查不到就断定文件坏了。
- **`xmllint --xpath` 不换行**：文本结果没有末尾换行，接管道前自己 `echo`。
- **miller 的 JSON 是逐行对象**，不是一个大数组；要数组用 `--ojson --jvstack`，或交给 `jq -s`。
- **`-I` 不是这里的参数**：这三个工具没有隔离模式；不要套用 Python 的习惯。
- **不要用 mlr 替代数据库**：几百万行的聚合虽然能跑，但手机内存有限；大分析优先底座 `duckdb`，已有 `jq`/`yq` 处理的 JSON/YAML 不必绕到 mlr。
- **编码**：输入不是 UTF-8 时先在上游转好；三个工具都按字节处理，乱码不会自动纠正。
