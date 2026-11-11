---
name: ml-tflite
description: 本机 TensorFlow Lite 推理（cccodroid 组件）：python-tflite-runtime 加载 .tflite 模型做 CPU 推理，附带一个 544 字节的 Apache-2.0 测试模型。自带 numpy，不依赖其他组件。用户要在设备上跑轻量模型、检查模型输入输出时使用。
---

# TensorFlow Lite 推理

组件带 `python-tflite-runtime` 2.21.0 和 numpy 2.5.4，自包含，不依赖 sci-python。

自带 `usr/share/ml-tflite/add.bin`——TensorFlow 官方仓库的 544 字节加法测试模型（Apache-2.0），只用于验证运行时和示例，不是通用模型。

## 先自检

```sh
ml-tflite selftest
```

最后一行应为 `===== 总结 ===== tflite=2.21.0 numpy=… model=PASS inference=PASS`，约 2 秒。它加载自带模型、填充零输入、执行一次推理并检查输出，不联网、不写用户目录。

如果报 `找不到 numpy`，就是组件没装完整——重装组件，不要 `pip install numpy` 另装一份。

## 运行链路

```
ml-tflite          本组件（$PREFIX/bin，Python 3.14）
  ├─ tflite_runtime  本组件（$PREFIX/lib/python3.14/site-packages/tflite_runtime）
  └─ numpy           本组件（$PREFIX/lib/python3.14/site-packages/numpy）
```

## 常用

### 看模型结构

```sh
ml-tflite inspect model.tflite
ml-tflite info
```

`inspect` 打印每个输入/输出张量的名字、shape、dtype，不会执行推理。

### 在 Python 里推理

```python
from tflite_runtime.interpreter import Interpreter
import numpy as np

interp = Interpreter(model_path="model.tflite")
interp.allocate_tensors()

inp = interp.get_input_details()[0]
out = interp.get_output_details()[0]

x = np.zeros(inp["shape"], dtype=inp["dtype"])   # 换成真实预处理后的数据
interp.set_tensor(inp["index"], x)
interp.invoke()
y = interp.get_tensor(out["index"])
print(y.shape, y.dtype, y)
```

- 输入 shape/dtype 必须和模型一致；图片模型通常要 `[1,H,W,3]`、`float32` 或 `uint8`，按模型要求做归一化。
- 多输入/多输出就遍历 `get_input_details()` / `get_output_details()`，不要假设只有一个。
- 当前运行时是 CPU；GPU/NNAPI delegate 未启用，别期待硬件加速。

## 模型从哪来

- 自己训练/导出：`converter = tf.lite.TFLiteConverter.from_saved_model(...)` 后在电脑上生成 `.tflite`，拷到手机。
- 公开模型：确认许可证允许在设备上使用；模型文件**不随组件分发**，需要用户自己下载或提供。
- 不要从不明来源加载模型：TFLite 文件是二进制数据，恶意构造的文件可能触发运行时漏洞；只用来路清楚的模型。

## 常见坑

- **numpy 缺失**：组件没装完整，重装本组件；不要 `pip install numpy` 另装一份。
- **shape 不匹配**：`set_tensor` 报 `Cannot set tensor: Dimension mismatch`，先 `ml-tflite inspect` 看真实 shape。
- **量化模型**：`uint8`/`int8` 输入要按模型的 scale/zero_point 量化，不能直接塞 0–255 的浮点数组。
- **大模型内存**：手机内存有限，几百 MB 的模型可能直接 OOM；先用小模型验证流程。
- **不是 TensorFlow 完整版**：没有训练、没有 `tf.data`、没有 Keras；只做推理。
- **不要把它当安全沙箱**：模型加载和推理都在当前进程里，没有额外隔离。
