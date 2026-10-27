# 错题强化闭环 · 离线 OCR 路线（第一层：无独显 / CPU 传统方案）

> 目标：在**无 GPU、纯 CPU** 环境下，为"错题拍照 → 文字/公式识别"提供可落地的离线 OCR。
> 三条路线互不互斥，建议按场景切换。

## 环境

- Python **3.12.7**（`C:/Users/ASUS/AppData/Local/Programs/Python/Python312/python.exe`）
- 虚拟环境：`.venv-ocr/`（已建，pip 装包走清华源 + 显式代理）
- 测试样张：`AndroidOCR-master/screenshot (3).jpg`
  - **真值**：`Android and PHP Development Best Practices`（图内红棕色斜体英文）

## 路线 A · RapidOCR（轻量 ONNX，推荐优先）

- 引擎：检测 + 方向分类 + 识别 三个 ONNX 模型，预打包，模型约 10–15MB
- 依赖：`rapidocr` + `onnxruntime`
- 安装：`.venv-ocr/Scripts/python.exe -m pip install rapidocr onnxruntime`
- 测试：`.venv-ocr/Scripts/python.exe scripts/ocr/test_rapidocr.py`
- 优点：极轻量、CPU 推理快、pip 即用；缺点：中文印刷体精度略逊 PaddleOCR

## 路线 B · PaddleOCR（飞桨全功能，含公式）

- 引擎：文字检测 + 识别 + 版面；可接 **PP-FormulaNet-S** 做公式→LaTeX
- 依赖：`paddlepaddle` + `paddleocr`（公式需 `paddleocr[doc-parser]`）
- 安装（**推荐钉 3.2.2**，避开 3.3.x 的 CPU onednn 崩溃 bug，且自带公式识别）：
  ```bat
  D:\AllSideProject\AICorrection\.venv-ocr\Scripts\python.exe -m pip install "paddlepaddle==3.2.2" -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
  D:\AllSideProject\AICorrection\.venv-ocr\Scripts\python.exe -m pip install "paddleocr[doc-parser]"
  ```
- 文本测试：`.venv-ocr/Scripts/python.exe scripts/ocr/test_paddle.py "<图>" ch`
- 公式测试：`.venv-ocr/Scripts/python.exe scripts/ocr/test_paddle.py --formula "<公式图>"`
- 注意：首次运行自动下载模型（体积较大），需网络通畅预热一次
- ⚠️ 最新 3.3.1 如需尝鲜：构造 `PaddleOCR` 时传 `enable_mkldnn=False` 绕过 onednn/PIR 崩溃（CPU 慢 3–6x）；`FLAGS_use_mkldnn=0` 环境变量**无效**。详见文末「onednn 回归」。

## 路线 C · AndroidOCR（实为 Tesseract）

- 本质：Android 端 Tesseract（tess-two）Demo，已自带词库
  - `AndroidOCR-master/app/src/main/assets/tessdata/chi_sim.traineddata`（13MB，中文）
  - `AndroidOCR-master/app/src/main/assets/tessdata/eng.traineddata`（15MB，英文）
- Windows 端复刻：装 `tesseract` 二进制（如 UB Mannheim 安装包）后
  `pip install pytesseract`，即可用同一套 traineddata 跑超轻量基线
- **启用步骤见文末「路线 C（Tesseract）启用步骤」**（装二进制 + `pip install pytesseract` + 指向自带词库，三步跑通）
- 当前本机状态：**✅ 已实测通过**（2026-10-28）；适用：极低资源 / 端侧；精度弱于 A/B，胜在极小
- ⚠️ 词库目录坑：**`TESSDATA_PREFIX` 要指向 `tessdata` 目录本身**（不是其父目录）。
  本版 tesseract 会直接在其后拼 `xxx.traineddata`，按「父目录」写法会报
  `Error opening data file .../assets\eng.traineddata`。
  另：不要改用 `--tessdata-dir "路径"`（加引号会被当成路径字符，同样打不开）。
- 语言串用 `chi_sim+eng` 中英混排，实测明显优于单语种。

## 与 Node 后端对接（已验证 2026-10-27）

OCR 为 Python 进程，以**子进程**方式供 TypeScript 后端调用，接口契约已跑通：

- 统一 CLI：`scripts/ocr/ocr_cli.py --engine rapid|paddle|tesseract --image "<图>" [--formula]`
  输出**单行 JSON**（字段）：`{"ok","engine","formula","elapsed_wall","elapsed_engine","count","texts":[{"text","score","box"}]}`
- Node 客户端样例：`scripts/ocr/ocr_client.mjs`，导出 `ocr(image, {engine, formula})`
  用法：`import { ocr } from './ocr_client.mjs'; const r = await ocr('x.jpg', { engine: 'rapid' });`
- 实测（2026-10-28）：四种组合全部返回正确 JSON ——
  `rapid`(7 块) / `paddle`(6 块) / `paddle --formula`(LaTeX) / `tesseract`(4 行)，真值均命中。
- ⚠️ 坑 1：paddle 引擎的 DEBUG 日志（Namespace 调试行）在某些管道场景下会写进 **stdout**，
  与单行 JSON 混流导致 Node 端 `JSON.parse` 失败 → 已抑制（`ppocr` logger→ERROR + `show_log=False`）。
- ⚠️ 坑 2：Paddle C++ 的 oneDNN 提示 `ReduceMeanCheckIfOneDNNSupport` 会直接写 **OS 层 fd 1**，
  Python 的 `logging` 管不到它 → `ocr_cli.py` 用 `_SilenceStdout`（`os.dup2` 把 fd 1 指向 devnull）
  在推理期间吞掉，推理结束后恢复，保证 stdout 只有一行 JSON。
- ⚠️ 公式仅 `paddle` 支持：其余引擎传 `--formula` 会直接返回 `ok:false` 并提示，不会静默按文本处理。
- 进阶（可选）：若需高并发，用 FastAPI/Flask 包一层 `/ocr` 接口，Node 走 fetch。

## 对比（2026-10-28 实测，样张 screenshot (3).jpg，模型均已缓存）

| 维度 | A. RapidOCR | B. PaddleOCR 3.2.2 | C. Tesseract |
|---|---|---|---|
| 安装体积 | 轻（rapidocr+onnxruntime+opencv） | 重（paddlepaddle 占大头） | 极小（无深度学习框架） |
| 模型/词库 | 约 15MB（PP-OCRv6 small 三件套） | 较大（PP-OCRv6_medium det/rec；公式另需 231MB） | chi_sim+eng=28MB（**词库已有**） |
| **单图耗时** | **2.44s**（引擎 1.86s） | **17.55s**（关重模块后；未关 40–43s） | **0.79s**（最快） |
| 中文印刷体 | 良（原图片/灰度图 1.000） | 优（原图片/灰度图 1.000） | 弱（原图片/灰度图 命中但有空格间隔） |
| 英文真值 | ✅ 0.9988 / 0.9995 | ✅ 0.9986 / 0.9889 | ⚠️ `Androl~d and PHP Development Best Practices` |
| 公式→LaTeX | 否 | ✅ **是**（PP-FormulaNet-S，**1.32s**） | 否 |
| 置信度/坐标 | ✅ 有 score + box | ✅ 有 score + box | ❌ 无（仅文本行） |
| 本机可运行 | ✅ 通过 | ✅ 通过（文本 + 公式） | ✅ 通过 |

### 结论：分工用，别单选

实测暴露一个关键取舍：**Paddle 3.x 文本很慢（17.5s），但公式能力无可替代（1.3s 且准）**。
对本产品（错题拍照 → 文字/公式识别）推荐**按内容分流**：

| 内容 | 用哪个 | 理由 |
|---|---|---|
| 题干/中文文本 | **A. RapidOCR** | 2.4s，精度已够，带坐标便于定位 |
| 数学公式 | **B. PaddleOCR `--formula`** | 唯一能出 LaTeX；1.3s 反而很快 |
| 极低资源兜底 | C. Tesseract | 0.8s 最快、无框架依赖，但无坐标且精度弱 |

> 提速提示：Paddle 3.x 文本默认会跑 PP-StructureV3 三件套（文档方向分类/矫正/文本行方向），
> 纯 CPU 上是数十倍慢的主因。脚本已显式关闭
> `use_doc_orientation_classify/use_doc_unwarping/use_textline_orientation=False`（40–43s → 17.6s）。
> 若只做文本、不要公式，可直接用 A 路线。

### PaddleOCR 本机 CPU 报错与修复（重要）
**现象**：`NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>] ... onednn_instruction.cc`
**原因**：PaddlePaddle 3.3.x 在部分 CPU 上的 onednn 后端回归 bug，与脚本写法无关（已试 `FLAGS_use_mkldnn=0`、`FLAGS_enable_pir_api=0` 均无效）。
**修复**：钉 **3.2.2**（无此 bug、onednn 全速、自带公式识别），见下文「Paddle 最新版」一节。
脚本已做 **2.x/3.x 自适应**（init 参数与调用方式按版本分支，返回结构也兼容），切版本无需改代码。

### 公式识别的两个隐藏依赖（重要，2026-10-28 实测）
PP-FormulaNet-S 的后处理 `UniMERNetDecode` 依赖两个**不在 paddleocr 默认依赖里**的包。
缺任一都会在创建 predictor 时抛：
```
RuntimeError: A dependency error occurred during predictor creation.
  ← 内层真实原因：DependencyError: `UniMERNetDecode` ... not available: tokenizers
```
```bat
.venv-ocr\Scripts\python.exe -m pip install tokenizers ftfy
```
- `tokenizers`：UniMERNet 分词器（缺它报 "not available: tokenizers"）
- `ftfy`：LaTeX 文本规整（装上 tokenizers 后会接着报 `No module named 'ftfy'`）

> 装包提示：本机代理会卡住 pip index（直接报 `from versions: none`），但 **curl 通**。
> 绕法：从清华源拉 wheel → 本地装。注意 pip 要求规范文件名，下载后要改名：
> `curl -o tokenizers-0.15.2-cp312-none-win_amd64.whl https://pypi.tuna.tsinghua.edu.cn/packages/...`
> `pip install ./tokenizers-0.15.2-cp312-none-win_amd64.whl`

**实测（2026-10-28，231MB 模型已缓存，1.32s）**：
```
输入（真值）：\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
输出 LaTeX ：\textstyle{\int_{0}^{\infty}}e^{-x^{2}}\,d x={\frac{\sqrt{\pi}}{2}}
```
结构完全命中（仅多一层 `\textstyle{}` 与 `{}` 包裹），可直接喂给后续归因/渲染。

### Paddle 最新版 / onednn 回归 bug（重要，2026-10-27 更新）
- **现象**：PaddlePaddle 3.3.0 / 3.3.1 纯 CPU 推理报
  `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>] ... onednn_instruction.cc`（GitHub #77340）。PaddleOCR 3.x 走 PaddleX，CPU 默认 `run_mode="mkldnn"`，触发 PIR/MKLDNN 不兼容。
- **这是运行时 bug，不是编译问题** → **源码重编无效**（会编出同样坏的 onednn 路径；且 Windows 上 bazel 编 Paddle 极重、基本不可行）。请勿走源码安装。
- **真正解法（二选一）**：
  1. **推荐：钉 `paddlepaddle==3.2.2`**（或 3.2.1）。这是「能跑的最新稳定版」——无此 bug、onednn 全速、且 3.x 自带 PP-FormulaNet-S 公式识别。
  2. 坚持 3.3.1：构造时传 `enable_mkldnn=False`（经 PaddleX 把 run_mode 切到 `paddle`，绕过坏路径），代价 CPU 推理慢 3–6 倍。
  - ⚠️ `FLAGS_use_mkldnn=0` 环境变量**无效**（PaddleX 自己控制 run_mode，忽略该 flag）。
- `scripts/ocr/ocr_cli.py` 与 `test_paddle.py` 已版本自适应：`major>=3` 关 PP-StructureV3 三件套
  （`use_doc_orientation_classify/use_doc_unwarping/use_textline_orientation=False`），且 `>=3.3` 自动加 `enable_mkldnn=False`。
- **当前实际版本**：`paddlepaddle 3.2.2` + `paddleocr 3.7.0` + `paddlex 3.7.2`，文本与公式均跑通。

### 路线 C（Tesseract）启用步骤
1. 装二进制：UB Mannheim installer `https://github.com/UB-Mannheim/tesseract/wiki`（默认 `C:\Program Files\Tesseract-OCR\`；语言包可选，反正用自带词库）
2. 装 Python 包：`.venv-ocr\Scripts\python.exe -m pip install pytesseract`
3. 词库：直接复用 `AndroidOCR-master/app/src/main/assets/tessdata/` 下的 `chi_sim.traineddata` / `eng.traineddata`（已就位，无需下载）；测试脚本会把 `TESSDATA_PREFIX` 指向 **tessdata 目录本身**
4. 测试（2026-10-28 已通过）：
   - 中英混排：`.venv-ocr\Scripts\python.exe scripts/ocr/ocr_cli.py --engine tesseract --image "AndroidOCR-master/screenshot (3).jpg"`
   - 单独语种：`.venv-ocr\Scripts\python.exe scripts/ocr/test_tesseract.py "AndroidOCR-master/screenshot (3).jpg" chi_sim`
5. C 路线胜在极小（词库 28MB、无深度学习框架），精度弱于 A/B，仅作端侧/极低资源兜底。
6. ⚠️ 二进制不在 PATH 时，脚本会显式回退到 `C:\Program Files\Tesseract-OCR\tesseract.exe`（UB Mannheim 默认路径），无需手动配 PATH。
