# 路线 C —— AndroidOCR：只读分析 + Windows 可复刻性评估

> 结论先行：**这是一个 Android / Gradle 工程，在 Windows 上无法直接运行该 App。**
> 本路线不做"跑通"承诺，仅提取可复用资产并评估用 `pytesseract` 复刻的可行性。

---

## 1. 项目性质判定（证据）

路径：`D:/AllSideProject/AICorrection/AndroidOCR-master`

| 证据 | 内容 |
|------|------|
| 构建文件 | `build.gradle`（根）+ `app/build.gradle` + `settings.gradle` + `gradlew` / `gradlew.bat` |
| Android 插件 | `classpath 'com.android.tools.build:gradle:7.1.1'` |
| 应用配置 | `applicationId "com.wt.ocr"`，`compileSdkVersion 33`，`minSdkVersion 21`，`versionName "1.1.0"` |
| 源码结构 | `app/src/main/java/com/wt/ocr/...`（Java，非 Kotlin） |
| 硬件依赖 | CameraX 相机取景（`androidx.camera:camera-*:1.3.0-alpha04`）、`androidTest` 仪器化测试 |

→ **判定：标准 Android App。Windows 无 Android 运行时，且依赖 CameraX 硬件取景，故"跑通该 App"在本机不可行。**

---

## 2. 可复用资产清单

### 2.1 Tesseract 语言包（最重要的可移植资产）

```
AndroidOCR-master/app/src/main/assets/tessdata/chi_sim.traineddata   13,077,423 B  (~12.5 MB)
AndroidOCR-master/app/src/main/assets/tessdata/eng.traineddata       15,400,601 B  (~14.7 MB)
```

`.traineddata` 是 **跨平台通用** 的 Tesseract 语言模型文件，可直接拷贝给 Windows 版 Tesseract 使用，无需转换。
（项目里还带 4 张 `screenshot*.jpg` 作为效果展示图。）

### 2.2 OCR 引擎与关键依赖

| 依赖 | 版本 | 作用 |
|------|------|------|
| `cz.adaptech.tesseract4android:tesseract4android` | 4.4.0 | Tesseract 4 的 Android JNI 封装 |
| `com.edmodo:cropper` | 1.0.1 | 拍照后手动裁剪（对准题干区域） |
| `androidx.camera:camera-*` | 1.3.0-alpha04 | 相机预览 + 拍照 |
| `com.google.firebase:firebase-bom` | 31.5.0 | 埋点/分析（与本项目无关） |

---

## 3. 调用方式与预处理逻辑（可直接复刻）

核心文件：`app/src/main/java/com/wt/ocr/ShowCropperedActivity.java`

### 3.1 引擎初始化与识别

```java
private static final String LANGUAGE = "chi_sim";   // L36：简体中文（可选 eng）
private TessBaseAPI baseApi = new TessBaseAPI();    // L47

baseApi.init(LANGUAGE_PATH, LANGUAGE);                       // L97 字典库路径 + 语言
baseApi.setPageSegMode(TessBaseAPI.PageSegMode.PSM_AUTO);    // L99 自动分页
baseApi.setImage(bitmap_1);                                   // L189
result = baseApi.getUTF8Text();                               // L190 取文本
baseApi.recycle();                                             // L191
```

复刻要点：`lang=chi_sim` + `--psm 3`（PSM_AUTO 对应 tesseract 的 psm 3）。

### 3.2 灰度化（`convertGray`，L108 — **实际被调用**）

```java
colorMatrix.setSaturation(0);   // ColorMatrixColorFilter 去饱和 → 灰度
```
识别线程 L187 实际执行的是 `convertGray(BitmapFactory.decodeFile(path))`，即**只做了灰度化**。

### 3.3 二值化（`binaryzation`，L127 — 已定义但**未被主线程调用**）

逐像素处理，阈值 `tmp` 默认 100：

1. 对 R/G/B 三个通道分别：`> tmp ? 255 : 0`（通道级硬阈值）
2. 加权灰度：`gray = R*0.3 + G*0.59 + B*0.11`
3. 再次二值：`gray <= 95 ? 0 : 255`

> ⚠️ 诚实标注：该方法是**死代码**（定义了但未在识别流程中调用）。
> 若要在 Windows 复刻并启用二值化，需自行接入；且该硬阈值对拍照错题的阴影/光照不均**容易丢失笔画**，不建议直接照搬。

---

## 4. Windows 复刻可行性评估（pytesseract）

### 4.1 系统二进制状态（初次评估 → 后续更新）

> **初次评估（本文件撰写时）**：本机**没有** tesseract 二进制，判定为"需用户自行安装"。
> ```
> $ which tesseract                                   → NOT_FOUND
> $ ls "C:/Program Files/Tesseract-OCR/tesseract.exe" → No such file or directory
> ```

> **后续更新**：用户已安装 tesseract，现位于 `C:\Program Files\Tesseract-OCR\tesseract.exe`，
> 路线 C **已可实际运行**（CLI `--engine tesseract` 实测 0.42s 返回）。
> 但**识别质量很差**——同一张中文图（RapidOCR 能完整读出 18 个文本块），
> Tesseract 只输出 `图 © WIE © Yi`（1 行，且是噪声）。详见 §5。

`pytesseract` 只是 `tesseract` 命令行的 Python 封装，**必须**先装系统二进制。
→ 若换机器仍缺失，标注为 **需用户自行安装**（见 §4.2）。

### 4.2 用户需执行的安装（Windows 推荐 UB Mannheim 构建）

下载地址（官方推荐的 Windows 安装包）：
**https://github.com/UB-Mannheim/tesseract/wiki**

安装时勾选 **Chinese (Simplified)** 语言包；或装完后把本项目的 `chi_sim.traineddata`、`eng.traineddata`
拷到 tesseract 的 `tessdata` 目录（默认 `C:\Program Files\Tesseract-OCR\tessdata\`）。

### 4.3 复刻后的等效代码（**未在本机验证**，因缺二进制）

```bash
.venv-ocr/Scripts/python.exe -m pip install pytesseract pillow opencv-python \
    -i https://pypi.tuna.tsinghua.edu.cn/simple
```

```python
import cv2, pytesseract
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

img = cv2.imread("path/to/mistake.jpg")
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)                 # 复刻 convertGray
_, bin_ = cv2.threshold(gray, 100, 255, cv2.THRESH_BINARY)   # 复刻 binaryzation(tmp=100)

text = pytesseract.image_to_string(bin_, lang="chi_sim", config="--psm 3")
print(text)
```

### 4.4 价值评估（结论）

| 维度 | 评价 |
|------|------|
| 中文印刷体 | 可用，但对**拍照错题**（光照不均、倾斜、手写混入）明显弱于 RapidOCR / PaddleOCR |
| 手写体 | 基本不可用（Tesseract 4 LSTM 对中文手写很差） |
| 公式 | **不支持**，无任何 LaTeX 输出能力 |
| 部署成本 | 需系统级二进制安装，无法用纯 pip 交付 → **不利于本项目的一键交付目标** |
| 真实价值 | 主要是**端侧（Android）参考**：证明了"摄像头取景 → 裁剪 → 灰度 → Tesseract"这条极轻量链路在移动端可行 |

**建议：不作为本项目的 OCR 主力路线**，仅在"未来要做安卓端离线兜底"时回看其裁剪 + 预处理思路。

---

## 5. 真实运行结论（更新）

| 项目 | 结论 |
|------|------|
| Android App 本体 | **仍无法在 Windows 运行** —— Android/Gradle 工程，依赖 CameraX 硬件取景（此点不变） |
| pytesseract 复刻路线 | **已跑通** —— 用户安装 tesseract 后，CLI `--engine tesseract` 可用，耗时 0.42s |

同一张中文图（`RapidOCR-main/python/tests/test_files/ch_en_num.jpg`）横向对比实测：

| 引擎 | count | 输出 |
|------|-------|------|
| RapidOCR | 18 | 正品促销 / 大桶装更划算 / 强力去污符合国标 / -40℃深度防冻不结冰 / 极速发货 / 冰点标准 / 破损就赔 / 假一赔十（**全部正确**） |
| Tesseract | 1 | `图 © WIE © Yi`（**噪声，无可信息**） |

→ 结论：Tesseract 路线"能跑"但"不好用"，**不建议作为本项目主力 OCR**；
其价值仍主要是端侧（Android 离线兜底）参考。
