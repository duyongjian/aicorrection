# llama.cpp 本地部署方案（MiniCPM-V 4.5 · RTX 4060 8GB）

> 整理时间：2026-10-27 · 决策者：杜咏键（道源）
> 路线：**llama.cpp 原生部署**（不走 Ollama），对显存/量化档位控制更精细。

---

## 一、环境实测结论（本机）

| 项目 | 实测值 | 影响 |
|------|--------|------|
| GPU | NVIDIA GeForce RTX 4060（8188 MiB） | 属「第三层：4060 主力 AI」档 |
| CUDA UMD 版本 | **13.4** | 必须下 `cuda-13.4` 包，不是 12.4 |
| HuggingFace | ❌ **HTTP 000 不可达** | 所有 HF 链接作废 |
| ModelScope（魔搭） | ✅ HTTP 200 可直连 | **唯一可用下载源** |
| 磁盘 | C 盘剩 65G / D 盘剩 145G | 模型放 **D 盘** |
| 已装模型（Ollama） | qwen3:8b-8k / qwen2.5:0.5b / qwen3:8b | 均**无视觉能力**，OCR 目前走 Mock |

---

## 二、完整下载清单（可直接复制）

### 2.1 llama.cpp 运行时（Windows / CUDA 13.4 / x64）

| 文件 | 大小 | 必需性 | 直链 |
|------|------|--------|------|
| `llama-b11900-bin-win-cuda-13.4-x64.zip` | 157.1 MB | ✅ 必需（主程序） | https://github.com/ggml-org/llama.cpp/releases/download/b11900/llama-b11900-bin-win-cuda-13.4-x64.zip |
| `cudart-llama-bin-win-cuda-13.4-x64.zip` | 403.9 MB | ✅ **必需**（CUDA 运行时 DLL，缺了跑不起来） | https://github.com/ggml-org/llama.cpp/releases/download/b11900/cudart-llama-bin-win-cuda-13.4-x64.zip |
| `llama-b11900-bin-win-cpu-x64.zip` | 23.1 MB | ⭕ 备选（无独显时用） | https://github.com/ggml-org/llama.cpp/releases/download/b11900/llama-b11900-bin-win-cpu-x64.zip |

> 注：llama.cpp 的 Windows CUDA 包**不再**叫 `cublas`，统一叫 `cuda`。
> 最新构建号 `b11900`（2026-10 系列）。

### 2.2 MiniCPM-V 4.5 GGUF 权重（ModelScope 镜像，非 HF）

仓库：`OpenBMB/MiniCPM-V-4_5-gguf`
ModelScope 页：https://www.modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf

| 文件 | 大小 | 必需性 | 直链 |
|------|------|--------|------|
| `ggml-model-Q4_K_M.gguf` | 4793 MB (4.7 GB) | ✅ **推荐主力** | https://www.modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/ggml-model-Q4_K_M.gguf |
| `mmproj-model-f16.gguf` | 1044 MB (1.0 GB) | ✅ **必需**（视觉投影，缺了无法读图） | https://www.modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/mmproj-model-f16.gguf |

**其它量化档位（按需替换主权重）**

| 档位 | 大小 | 4060 8GB 适配 |
|------|------|---------------|
| Q4_0 | 4552 MB | ✅ 舒适，精度略低 |
| **Q4_K_M** | **4793 MB** | ✅ **推荐**（精度/显存平衡） |
| Q5_K_M | 5578 MB | ✅ 可跑，显存偏紧 |
| Q6_K | 6413 MB | ⚠️ 勉强 |
| Q8_0 | 8304 MB | ❌ 放不下 |
| F16 | 15625 MB | ❌ 需多卡 |

> 显存核算（Q4_K_M）：主权重 4.7G + mmproj 1.0G ≈ **5.7 GB**，
> 8GB 显存留有 ~2.3G 余量给 KV cache 与图像编码，安全。

### 2.3 传统 OCR 兜底（可选，已下载未解压）

| 资源 | 文件 | 用途 |
|------|------|------|
| PaddleOCR | `D:/AllSideProject/AICorrection/PaddleOCR-main.zip`（106 MB） | CPU 文字识别兜底 |
| RapidOCR | `D:/AllSideProject/AICorrection/RapidOCR-main.zip`（2.2 MB） | 极轻量 CPU OCR（10–15MB 模型） |
| AndroidOCR | `D:/AllSideProject/AICorrection/AndroidOCR-master.zip`（27 MB） | 端侧/Android 参考实现 |

---

## 三、部署目录规划

```
D:/models/
├── _downloads/                     # 下载的 zip（可后续删除）
├── llama-b11900/                   # 解压后的运行时
│   ├── llama-server.exe            # OpenAI 兼容服务端（本项目接这个）
│   ├── llama-cli.exe
│   └── *.dll                       # cudart 运行时
└── MiniCPM-V-4_5-gguf/
    ├── ggml-model-Q4_K_M.gguf      # 4.7 GB
    └── mmproj-model-f16.gguf       # 1.0 GB
```

---

## 四、一键脚本

```bash
bash D:/AllSideProject/AICorrection/aicorrection-v0.1/scripts/setup_llama_cpp.sh
```

脚本会依次下载 4 个文件（约 6.4 GB）并解压运行时。

---

## 五、启动与验证

```bash
# 1. 确认二进制可用
D:/models/llama-b11900/llama-cli.exe --version

# 2. 启动 OpenAI 兼容服务（本项目后端直接对接）
D:/models/llama-b11900/llama-server.exe \
  -m D:/models/MiniCPM-V-4_5-gguf/ggml-model-Q4_K_M.gguf \
  --mmproj D:/models/MiniCPM-V-4_5-gguf/mmproj-model-f16.gguf \
  -ngl 99 -c 8192 --port 8080
```

- `-ngl 99`：全部层卸载到 GPU（4060 必开）
- `--mmproj`：视觉投影，**不加则图片输入无效**
- 服务起来后端点为 `http://localhost:8080/v1`（OpenAI 兼容）

---

## 六、本项目接入改造（下一步）

当前 `apps/api/.env`：
```
VISION_MODEL=llama3.2-vision   # 未安装 → 走 Mock
```

改为 llama.cpp 端点后：
```
LLM_PROVIDER=ollama            # 保持 OpenAI 兼容协议即可
LLM_BASE_URL=http://localhost:8080/v1
VISION_MODEL=minicpm-v-4.5-q4km
```

> 关键点：`OllamaProvider` 走的就是 **OpenAI 兼容协议**，
> 而 llama-server 同样提供 `/v1/chat/completions`，
> 因此**后端代码零改动**，只需把 `LLM_BASE_URL` 指向 8080 即可。
> 唯一需确认的是 `chatWithImage` 里 `image_url` 的 base64 data URI 格式是否被 llama-server 接受（待实测）。

---

## 七、模型选型备忘

| 模型 | 中文 OCR | 公式 | 4060 适配 | 结论 |
|------|---------|------|-----------|------|
| **MiniCPM-V 4.5** Q4_K_M | ⭐⭐⭐⭐⭐ (OCRBench 876) | 强 | ✅ 5.7GB | **主力** |
| LLaVA 1.6 7B | ⭐⭐（弱于 MiniCPM-V） | 一般 | ~7.8GB 偏紧 | 仅英文/图表补充 |
| Qwen2.5-VL 7B | ⭐⭐⭐⭐ | 强 | ~5-6GB | 备选（若 MiniCPM 效果不佳） |

> 结论：中文搜题场景 **MiniCPM-V 4.5 优先于 LLaVA**。
> LLaVA 主场在英文图文描述/图表理解，中文 OCR 明显弱。
