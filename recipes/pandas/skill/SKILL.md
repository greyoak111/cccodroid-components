---
name: pandas
description: 本机 pandas 数据分析（cccodroid 组件）：DataFrame 读写 CSV/Parquet/Excel、筛选、分组聚合、缺失值、日期索引。自带 numpy，不依赖其他组件。用户要在设备上清洗表格、算统计、导出结果时使用。
---

# pandas 数据分析

组件带 pandas 3.1.1 和 numpy 2.5.4，自包含，不依赖 sci-python。

## 先自检

```sh
pandas-selftest
```

最后一行应为 `===== 总结 ===== pandas=3.1.1 numpy=… groupby=PASS csv=PASS`，约 2 秒。它在 `$TMPDIR` 建 DataFrame、做 groupby 和 CSV 往返，不碰用户文件、不联网。

如果报 `找不到 numpy`，就是组件没装完整——重装组件，不要 `pip install numpy` 另装一份。

## 运行链路

```
pandas-selftest   本组件（$PREFIX/bin，Python 3.14）
  ├─ pandas       本组件（$PREFIX/lib/python3.14/site-packages/pandas）
  └─ numpy        本组件（$PREFIX/lib/python3.14/site-packages/numpy）
```

装好后 Python 直接 `import pandas` 即可；不需要改 `PYTHONPATH`。

## 常用

```python
import pandas as pd

df = pd.read_csv("data.csv")
df = pd.read_parquet("data.parquet")
df = pd.read_excel("data.xlsx")          # 需要 openpyxl，未随组件安装
df.head()
df[df["score"] > 60]
df.groupby("team")["score"].agg(["count", "mean", "max"])
df.fillna(0)
df.dropna(subset=["score"])
df.sort_values("score", ascending=False)
df.to_csv("out.csv", index=False)
df.to_parquet("out.parquet", index=False)
```

命令行直接跑一段：

```sh
python3 - <<'PY'
import pandas as pd
df = pd.read_csv("data.csv")
print(df.groupby("team")["score"].mean())
PY
```

## 常见坑

- **内存**：pandas 会把整列读进内存；手机上超过几十万行、很多文本列就危险。先 `df = pd.read_csv(path, nrows=1000)` 看结构，大文件用 `dtype`/`usecols` 限列，或改用底座 `duckdb` 做聚合。
- **不要 `pip install pandas/numpy`**：会装第二份、和组件冲突；缺依赖就重装本组件。
- **Excel 需要 openpyxl**：组件没带；要读 xlsx 先 `pip install --user openpyxl`，或者用底座 `libreoffice` 转 CSV。
- **日期解析慢**：`parse_dates=` 大文件会明显变慢；能先转成 ISO 字符串再按需解析。
- **写 Parquet 需要 pyarrow**：sci-python 已带 pyarrow；从这里 `to_parquet` 通常可用。
- **中文列名**没问题，但 `df.query()` 里用反引号包住：``df.query("`销售额` > 100")``。
- **输出到终端**：大表先 `.head()`；`print(df)` 会把整表刷屏。
