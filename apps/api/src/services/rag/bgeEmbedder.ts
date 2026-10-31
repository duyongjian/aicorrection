/**
 * 本地 bge-m3 语义嵌入（P2 题库 RAG 语义增强）
 *
 * 方案：@huggingface/transformers（v3+，自带 onnxruntime + 分词器），
 * 从本地目录 env.BGE_MODEL_DIR 离线加载 bge-m3，做 CLS pooling + L2 归一化。
 *
 * 设计原则（硬约束）：
 *  - 本模块只负责"真实语义嵌入"。任何缺失 / 加载 / 推理失败都抛【可识别错误】，
 *    由 embeddingService 捕获并回落 localHashEmbed —— 本模块绝不静默返回错误维度或崩。
 *  - 强制离线：allowRemoteModels=false + local_files_only=true，绝不联网。
 *  - 懒加载 + 动态 import：@huggingface/transformers 依赖 onnxruntime-node 原生模块，
 *    仅在真正启用 bge 且存在模型时才动态加载；默认 local-hash 路径与"缺模型回落"
 *    路径【绝不】触碰该依赖，从而保证 local-hash 永不因缺依赖/缺模型而崩。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { env } from '../../config/env';

/** 模型文件缺失（上层据此直接回落 local-hash）。 */
export class BgeModelMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgeModelMissingError';
  }
}

/** 模型加载 / 推理失败（上层据此回落 local-hash）。 */
export class BgeInferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgeInferenceError';
  }
}

/** 已加载（或加载中的）feature-extraction pipeline 单例。 */
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * 判断 BGE_MODEL_DIR 是否具备最小可用文件集：
 *  config.json + tokenizer.json + onnx/*.onnx（至少其一）。
 * 用于"缺文件直接回落"，避免无谓的加载 / 联网尝试。
 */
export function isBgeModelAvailable(): boolean {
  if (!fs.existsSync(env.BGE_MODEL_DIR)) return false;
  if (!fs.existsSync(path.join(env.BGE_MODEL_DIR, 'config.json'))) return false;
  if (!fs.existsSync(path.join(env.BGE_MODEL_DIR, 'tokenizer.json'))) return false;
  const onnxDir = path.join(env.BGE_MODEL_DIR, 'onnx');
  if (!fs.existsSync(onnxDir)) return false;
  return fs.readdirSync(onnxDir).some((f) => f.toLowerCase().endsWith('.onnx'));
}

/**
 * 选择 onnx 变体：优先量化版（体积小 / 推理快）。
 *  - 目录内存在 quantized / q8 命名的 onnx → 'q8'
 *  - 否则 → 'fp32'
 */
function resolveDtype(): 'q8' | 'fp32' {
  const onnxDir = path.join(env.BGE_MODEL_DIR, 'onnx');
  if (fs.existsSync(onnxDir)) {
    const files = fs.readdirSync(onnxDir);
    if (files.some((f) => /quantized|[_-]?q8/i.test(f))) return 'q8';
  }
  return 'fp32';
}

/** 懒加载单例 pipeline；首次调用加载，失败清空缓存以便重试。 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    if (!isBgeModelAvailable()) {
      throw new BgeModelMissingError(
        `BGE 模型文件缺失于 ${env.BGE_MODEL_DIR}（需 config.json / tokenizer.json / onnx/*.onnx）。`
      );
    }

    // 动态加载 transformers（仅真正需要 bge 时）。默认 local-hash 与"缺模型回落"
    // 路径不会执行到这里，因此不会引入 onnxruntime-node 原生依赖，local-hash 永不崩。
    let mod: typeof import('@huggingface/transformers');
    try {
      mod = await import('@huggingface/transformers');
    } catch (e) {
      throw new BgeInferenceError(
        `BGE 依赖(@huggingface/transformers / onnxruntime-node)加载失败，可能未安装：${(e as Error).message}`
      );
    }

    // 强制离线：绝不联网下载。
    mod.env.allowLocalModels = true;
    mod.env.allowRemoteModels = false;
    mod.env.localModelPath = env.BGE_MODEL_DIR;

    try {
      return await mod.pipeline('feature-extraction', env.BGE_MODEL_DIR, {
        local_files_only: true,
        device: env.BGE_DEVICE,
        dtype: resolveDtype(),
      });
    } catch (e) {
      throw new BgeInferenceError(`BGE 模型加载失败：${(e as Error).message}`);
    }
  })();

  // 若加载失败，清空缓存，下次调用可重试（而非永久缓存坏状态）。
  extractorPromise.catch(() => {
    extractorPromise = null;
  });

  return extractorPromise;
}

/** 生成指定维度的零向量（空文本时与 localHashEmbed 行为一致）。 */
function zeroVector(dim: number): number[] {
  return new Array<number>(dim).fill(0);
}

/**
 * 嵌入单条文本为 env.BGE_DIM(1024) 维 L2 归一化向量。
 *
 * @param text 文本（空 / 纯空白 → 返回零向量）
 * @returns 1024 维 L2 归一化向量
 * @throws BgeModelMissingError 模型文件缺失
 * @throws BgeInferenceError   模型加载 / 推理失败
 */
export async function bgeEmbed(text: string): Promise<number[]> {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return zeroVector(env.BGE_DIM);

  const extractor = await getExtractor();
  try {
    // CLS pooling + L2 归一化：bge-m3 标配用法。
    const output = await extractor._call(trimmed, {
      pooling: 'cls',
      normalize: true,
    });

    const data = output.data as Float32Array;
    const dim = data.length;
    if (dim !== env.BGE_DIM) {
      throw new BgeInferenceError(
        `BGE 输出维度(${dim})与期望(${env.BGE_DIM})不符，可能模型/配置不匹配。`
      );
    }
    return Array.from(data);
  } catch (e) {
    if (e instanceof BgeModelMissingError || e instanceof BgeInferenceError) {
      throw e;
    }
    throw new BgeInferenceError(`BGE 推理失败：${(e as Error).message}`);
  }
}
