#!/usr/bin/env bash
# ============================================================
# llama.cpp 本地部署一键准备脚本（RTX 4060 8GB / CUDA 13.4）
# 用途：下载 llama.cpp 运行时 + MiniCPM-V 4.5 GGUF 权重
# 运行：bash scripts/setup_llama_cpp.sh
# ============================================================
set -euo pipefail

BASE="${MODEL_BASE:-D:/models}"
DL="$BASE/_downloads"
BIN_DIR="$BASE/llama-b11900"
MODEL_DIR="$BASE/MiniCPM-V-4_5-gguf"

LLAMA_TAG="b11900"
CUDA_VER="13.4"

mkdir -p "$DL" "$BIN_DIR" "$MODEL_DIR"

echo "=========================================="
echo " llama.cpp 部署准备"
echo " 运行时目录: $BIN_DIR"
echo " 模型目录  : $MODEL_DIR"
echo "=========================================="

# ---------- 1. llama.cpp 运行时（CUDA 13.4）----------
echo ""
echo "[1/4] 下载 llama.cpp Windows CUDA-${CUDA_VER} 主程序 (~157MB)..."
if [ ! -f "$DL/llama-cuda.zip" ]; then
  curl -L --progress-bar -o "$DL/llama-cuda.zip" \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-win-cuda-${CUDA_VER}-x64.zip"
else
  echo "  已存在，跳过"
fi

echo ""
echo "[2/4] 下载 cudart 运行时 DLL (~404MB，CUDA 版必需)..."
if [ ! -f "$DL/cudart.zip" ]; then
  curl -L --progress-bar -o "$DL/cudart.zip" \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/cudart-llama-bin-win-cuda-${CUDA_VER}-x64.zip"
else
  echo "  已存在，跳过"
fi

# ---------- 2. MiniCPM-V 4.5 GGUF 权重（ModelScope 镜像）----------
echo ""
echo "[3/4] 下载 MiniCPM-V 4.5 Q4_K_M 主权重 (~4.7GB)..."
if [ ! -f "$MODEL_DIR/ggml-model-Q4_K_M.gguf" ]; then
  curl -L --progress-bar -o "$MODEL_DIR/ggml-model-Q4_K_M.gguf" \
    "https://www.modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/ggml-model-Q4_K_M.gguf"
else
  echo "  已存在，跳过"
fi

echo ""
echo "[4/4] 下载 mmproj 视觉投影 (~1.0GB，图片输入必需)..."
if [ ! -f "$MODEL_DIR/mmproj-model-f16.gguf" ]; then
  curl -L --progress-bar -o "$MODEL_DIR/mmproj-model-f16.gguf" \
    "https://www.modelscope.cn/models/OpenBMB/MiniCPM-V-4_5-gguf/resolve/master/mmproj-model-f16.gguf"
else
  echo "  已存在，跳过"
fi

# ---------- 3. 解压运行时 ----------
echo ""
echo "解压 llama.cpp 主程序..."
cd "$BIN_DIR" && tar -xf "$DL/llama-cuda.zip" && echo "  主程序解压完成"
echo "解压 cudart 运行时..."
cd "$BIN_DIR" && tar -xf "$DL/cudart.zip" && echo "  cudart 解压完成"

echo ""
echo "=========================================="
echo " 完成！"
echo " 运行时: $BIN_DIR"
echo " 模型  : $MODEL_DIR"
echo ""
echo " 验证命令（先确认 llama-cli 能识别 GPU）:"
echo "   $BIN_DIR/llama-cli.exe --version"
echo ""
echo " 启动服务（OpenAI 兼容端点，供本项目接入）:"
echo "   $BIN_DIR/llama-server.exe \\"
echo "     -m $MODEL_DIR/ggml-model-Q4_K_M.gguf \\"
echo "     --mmproj $MODEL_DIR/mmproj-model-f16.gguf \\"
echo "     -ngl 99 -c 8192 --port 8080"
echo "=========================================="
