# 错题强化闭环 - OCR与AI模型方案（道源确认版）

> 整理时间：2026-10-27
> 决策者：杜咏键（道源）

---

## 一、方案总览（三层递进）

| 层级 | 硬件 | 技术栈 | 核心定位 | 关键数据 |
|------|------|--------|----------|----------|
| **第一层：非AI传统方案** | CPU/无独显 | PaddleOCR轻量流水线（PP-OCRv6 + PP-FormulaNet-S）或RapidOCR | 确定性基线，完全离线，兜底层 | CPU可跑；RapidOCR模型仅10–15 MB |
| **第二层：低配AI入门** | 核显/低显存(<4GB) | MiniCPM-V 1B级变体（Q4 GGUF） | 预筛选、简单题目直读、置信度路由 | 权重显存~1 GB |
| **第三层：RTX 4060主力** | RTX 4060 8GB | MiniCPM-V 4.5 Q4_K_M + 传统流水线兜底 | 标准场景快速通道，中文OCR/文档解析主力 | OCRBench 876；Q4约6.2–6.8GB，~33 tok/s，16K上下文 |
| **第三层补充AI** | RTX 4060 8GB | LLaVA 1.6 7B Q4_K_M | 英文题目、图表理解辅助 | ~7.8GB（紧），~40 tok/s；中文OCR弱于MiniCPM-V |

### 核心判断

> **中文搜题场景，MiniCPM-V 4.5 是比 LLaVA 更对路的 AI 选项。**
> LLaVA 的价值主要在英文图像描述和图表理解，而非中文OCR/公式识别。

---

## 二、当前项目现状（道源环境）

| 项目 | 状态 |
|------|------|
| Ollama | v0.40.10 已安装，已运行 |
| 已拉取模型 | `qwen3:8b-8k`（4983MB）、`qwen2.5:0.5b`（379MB）、`qwen3:8b`（4983MB） |
| 配置目标视觉模型 | `llama3.2-vision`（未安装，走Mock兜底） |
| 硬件 | Windows笔记本，**未知显卡型号**（待确认） |
| OCR模块 | `apps/api/src/services/ocr/ocrService.ts`（当前仅文本入口可用，图片入口全部Mock） |

---

## 三、道源确认方案：LLaMA系为主

用户明确选择：**AI模型部分使用 LLaMA 生态**（Ollama管理），而非PaddleOCR。

### 3.1 下载清单（按优先级排序）

#### 🥇 必须下载（主力OCR视觉模型）

```bash
# Option A: MiniCPM-V 4.5（中文搜题首选，OCRBench 876）
ollama pull openbmb/MiniCPM-V-4_5:Q4_K_M

# Option B: llama3.2-vision（之前配置的目标，多模态能力均衡）
ollama pull llama3.2-vision

# Option C: qwen2.5-vl（阿里视觉语言模型，中文支持好）
ollama pull qwen2.5-vl:7b-instruct
```

#### 🥈 建议下载（英文/图表辅助）

```bash
# LLaVA 1.6 7B（英文图文理解补充，显存紧但可跑）
ollama pull llava:7b

# 或者 LLaVA Next（更新版本）
ollama pull llava-next:7b
```

#### 🥉 轻量备用（低配设备/快速测试）

```bash
# phi-3.5-vision（微软轻量多模态，~2GB）
ollama pull phi-3.5-vision

# Moondream2（极致轻量，~2GB）
ollama pull moondream
```

### 3.2 下载命令（一键执行）

```bash
# 第一步：确认Ollama服务运行中
curl -s http://localhost:11434/api/tags

# 第二步：拉取主力视觉模型（推荐先试MiniCPM-V 4.5）
ollama pull openbmb/MiniCPM-V-4_5:Q4_K_M

# 备选方案（如果网络受限，先用llama3.2-vision）
ollama pull llama3.2-vision
```

### 3.3 模型对比速查表

| 模型 | 大小 | 中文OCR | 公式识别 | 适合场景 | 推荐度 |
|------|------|---------|----------|----------|--------|
| **MiniCPM-V 4.5** Q4 | ~5GB | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 中文搜题主力 | **首选** |
| **llama3.2-vision** | ~2.3GB | ⭐⭐⭐ | ⭐⭐⭐ | 通用多模态 | 备选 |
| **qwen2.5-vl** 7B | ~5GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 中文/公式均衡 | 备选 |
| **LLaVA 1.6** 7B | ~4GB | ⭐⭐ | ⭐⭐ | 英文图文补充 | 补充 |
| **phi-3.5-vision** | ~2.4GB | ⭐⭐⭐ | ⭐⭐ | 轻量快速测试 | 轻量 |

---

## 四、代码改造计划

### 4.1 `.env` 配置变更

```bash
# ===== OCR 视觉模型配置（LLaMA系）=====
VISION_MODEL=openbmb/MiniCPM-V-4_5:Q4_K_M
# 备选: VISION_MODEL=llama3.2-vision
# 备选: VISION_MODEL=qwen2.5-vl:7b-instruct
```

### 4.2 `ocrService.ts` 改造方向

```typescript
// 当前问题：VISION_MODEL=llama3.2-vision（未安装）→ 走Mock
// 改造后：检测视觉模型可用性 → 自动降级/升级策略

export async function recognizeImage(imageBuffer: Buffer): Promise<OcrResult> {
  // 1. 优先尝试配置的视觉模型
  const result = await tryVisionModel(imageBuffer);
  
  // 2. 如果置信度不足，回退到文字提取Prompt
  if (result.confidence < 0.7) {
    return await fallbackToTextExtraction(imageBuffer);
  }
  
  return result;
}
```

---

## 五、下一步行动

1. **确认显卡型号**：`nvidia-smi` 或设备管理器
2. **执行下载**：按上方命令拉取视觉模型
3. **验证模型**：测试图片识别效果
4. **配置Ollama**：更新 `.env` 中的 `VISION_MODEL`
5. **改造代码**：更新 `ocrService.ts` 和 `ollamaProvider.ts`

---

## 六、参考链接汇总

| 资源 | 链接 |
|------|------|
| MiniCPM-V 4.5 GitHub | https://github.com/OpenBMB/MiniCPM-o |
| MiniCPM-V 4.5 HuggingFace | https://huggingface.co/openbmb/MiniCPM-V-4_5 |
| MiniCPM-V 4.5 GGUF量化 | https://huggingface.co/openbmb/MiniCPM-V-4_5-gguf |
| LLaVA 官网 | https://llava-vl.github.io/ |
| LLaVA 1.6 HuggingFace | https://huggingface.co/liuhaotian/llava-v1.6-vicuna-7b |
| Qwen2.5-VL HuggingFace | https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct |
| Ollama模型库 | https://ollama.com/library |
