# 错题强化闭环 v0.1 —— 全栈单体镜像（配方 3：Hugging Face Spaces / 任意 Docker 主机）
#
# 镜像内含：
#   - 后端 API（Node + Express + TS，经 tsx 运行）+ 前端静态资源（apps/web/dist，由同一进程托管）
#   - 本地 OCR 子进程（Python RapidOCR，纯 CPU，免费）
#   - 归因默认走云端大模型 API（ATTRIBUTION_STRATEGY=cloud，按量计费，免本地显存）
#
# HF Spaces（Docker SDK）会把容器端口映射到外部，并注入 PORT 环境变量。
# 本镜像监听 $PORT（默认 7860），绑定 0.0.0.0。

FROM node:20-bookworm

# 系统依赖：python3（本地 OCR 子进程）+ 原生模块编译工具
# （better-sqlite3 / onnxruntime-node 一般走预编译二进制，这里装 build-essential 兜底）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装 Python OCR 依赖（变更频率低，利用层缓存）
COPY deploy/huggingface/requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

# 复制工程（workspace 软链所需的根配置 + 各包源码）
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# 安装 Node 依赖（含 devDependencies：tsx / vite / typescript，构建阶段需要）
RUN npm install --no-audit --no-fund

# 构建：shared(dist) + web(vite build) + api(类型检查)
# 注意：此处先不要设 NODE_ENV=production，否则 npm install 会跳过 devDependencies。
RUN npm run build

# ---- 运行时环境变量 ----
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860
# 本地 OCR（CPU RapidOCR）免费；要省 CPU 可改 OCR_MODE=llm 走云端视觉（需配 VISION_*）
ENV OCR_MODE=auto
ENV OCR_PERSISTENT=true
ENV OCR_PYTHON=python3
ENV OCR_CLI=/app/apps/api/scripts/ocr/ocr_cli.py
# 归因走云端大模型 API（OpenAI 兼容端点）。需通过 HF Space / 容器环境变量注入：
#   CLOUD_BASE_URL, CLOUD_API_KEY, CLOUD_MODEL
# 也可同时配 VISION_BASE_URL / VISION_API_KEY / VISION_MODEL 让 OCR 用云端视觉大模型。
ENV ATTRIBUTION_STRATEGY=cloud

EXPOSE 7860

# HF 注入的 PORT 会覆盖上面的默认值；index.ts 已读取 process.env.PORT。
CMD ["sh", "-c", "npm run start:api"]
