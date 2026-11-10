#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
统一 OCR CLI —— 供 Node 后端以子进程方式调用，输出 JSON。
用法：
  .venv-ocr/Scripts/python.exe scripts/ocr/ocr_cli.py --engine rapid --image "<图>"
  .venv-ocr/Scripts/python.exe scripts/ocr/ocr_cli.py --engine paddle --image "<图>"
  .venv-ocr/Scripts/python.exe scripts/ocr/ocr_cli.py --engine paddle --formula --image "<公式图>"

输出（单行 JSON）：
  {"ok":true,"engine":"rapid","formula":false,"elapsed_wall":1.23,"elapsed_engine":0.98,
   "count":1,"texts":[{"text":"...","score":0.98,"box":[[x,y],...]}]}
  {"ok":false,"engine":"paddle","error":"..."}
"""
import sys
import os
import json
import time
import argparse


class _SilenceStdout:
    """在 OS 文件描述符层面屏蔽 stdout，连 Paddle C++（oneDNN 的
    ReduceMeanCheckIfOneDNNSupport 之类直接写 fd 1）也一并吞掉，
    保证本 CLI 最终只向 stdout 写一行 JSON，避免 Node 端 JSON.parse 失败。"""

    def __enter__(self):
        self._fd = sys.stdout.fileno()
        self._saved = os.dup(self._fd)
        self._devnull = open(os.devnull, "w")
        os.dup2(self._devnull.fileno(), self._fd)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        os.dup2(self._saved, self._fd)
        os.close(self._saved)
        self._devnull.close()
        return False


# 全局懒加载单例：serve 模式复用，避免每次请求重新构造引擎（P1-b）。
# 单次模式同样走这里，无副作用（首次构造，之后命中缓存）。
_RAPID = None
_PADDLE = None
_FORMULA = None


def _get_rapid():
    global _RAPID
    if _RAPID is None:
        from rapidocr import RapidOCR
        _RAPID = RapidOCR()  # 默认 onnxruntime 后端
    return _RAPID


def _get_paddle():
    global _PADDLE
    if _PADDLE is None:
        _PADDLE = _build_paddleocr()
    return _PADDLE


def _get_formula():
    global _FORMULA
    if _FORMULA is None:
        from paddleocr import FormulaRecognition
        _FORMULA = FormulaRecognition(model_name="PP-FormulaNet-S")
    return _FORMULA


def run_rapid(img: str, formula: bool):
    engine = _get_rapid()
    t0 = time.time()
    result = engine(img)  # RapidOCROutput
    wall = time.time() - t0
    elapse = sum(result.elapse_list) if result.elapse_list else 0.0
    texts = []
    if getattr(result, "txts", None):
        for box, text, score in zip(result.boxes, result.txts, result.scores):
            box_list = box.tolist() if hasattr(box, "tolist") else box
            texts.append({"text": text, "score": round(float(score), 4), "box": box_list})
    return texts, elapse, wall


def _build_paddleocr():
    """按 PaddlePaddle 主版本构造 PaddleOCR，规避 3.3.x 的 onednn/PIR CPU 崩溃 bug。

    - 2.x：use_angle_cls + lang（show_log=False 关调试日志）
    - 3.x：use_textline_orientation 替代 use_angle_cls；lang 已移除
    - PaddlePaddle 3.3.0/3.3.1 有 onednn 回归（GitHub #77340），需 enable_mkldnn=False
      绕过坏掉的 mkldnn/PIR 路径（CPU 慢 3-6x 但稳）；3.2.x 无此 bug，可保持 onednn 全速。
    """
    from paddleocr import PaddleOCR
    import paddle
    ver = paddle.__version__
    try:
        major = int(ver.split(".")[0])
        mm = tuple(int(x) for x in ver.split(".")[:2])
    except Exception:
        major, mm = 2, (2, 6)
    if major >= 3:
        # 关掉 PP-StructureV3 三件套重模块（文档方向分类 / 文档矫正 / 文本行方向），
        # 只保留纯 OCR（文本检测 + 文本识别）。3.x 默认会加载并运行这些大模型，
        # 是纯 CPU 上比 2.x 慢几十倍的主因。
        kwargs = {
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
        }
        if mm >= (3, 3):
            kwargs["enable_mkldnn"] = False
        try:
            return PaddleOCR(**kwargs)
        except TypeError:
            return PaddleOCR()
    try:
        return PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)
    except TypeError:
        return PaddleOCR(use_angle_cls=True, lang="ch")


def run_paddle(img: str, formula: bool):
    import logging

    # 抑制 ppocr 调试日志，保证 stdout 只有单行 JSON（否则 Namespace 行污染致 JSON.parse 失败）
    _lg = logging.getLogger("ppocr")
    _lg.setLevel(logging.ERROR)
    for _h in list(_lg.handlers):
        _lg.removeHandler(_h)

    if formula:
        model = _get_formula()
        t0 = time.time()
        with _SilenceStdout():
            output = model.predict(input=img)
        wall = time.time() - t0
        # 尽量提取 LaTeX，保证 JSON 可序列化（输出结构随版本变化）
        texts = []
        for res in output:
            latex = getattr(res, "rec_formula", None)
            if latex is None and isinstance(res, dict):
                latex = res.get("rec_formula") or res.get("latex")
            if latex:
                texts.append({"text": latex, "score": 1.0, "box": None})
        return texts, 0.0, wall
    ocr = _get_paddle()
    t0 = time.time()
    with _SilenceStdout():
        try:
            result = ocr.predict(img)  # 3.x
        except AttributeError:
            result = ocr.ocr(img, cls=True)  # 2.x
    wall = time.time() - t0
    texts = []
    # 3.x：list[dict]，含 rec_texts / rec_scores / dt_polys
    if result and isinstance(result[0], dict):
        rec_texts = result[0].get("rec_texts", []) or []
        rec_scores = result[0].get("rec_scores", []) or []
        dt_polys = result[0].get("dt_polys", []) or []
        for i, (text, score) in enumerate(zip(rec_texts, rec_scores)):
            box = dt_polys[i] if i < len(dt_polys) else None
            box_list = box.tolist() if hasattr(box, "tolist") else box
            texts.append({"text": text, "score": round(float(score), 4), "box": box_list})
    # 2.x：[[ (box,(text,score)), ... ]]
    elif result and result[0]:
        for line in result[0]:
            box, (text, score) = line
            box_list = box.tolist() if hasattr(box, "tolist") else box
            texts.append({"text": text, "score": round(float(score), 4), "box": box_list})
    # 2.x/3.x 文本模式均为同步阻塞，wall ≈ 引擎耗时
    return texts, wall, wall


def run_tesseract(img: str, formula: bool):
    """路线 C：Tesseract（AndroidOCR 即 Tesseract，词库自带 chi_sim + eng）。"""
    import shutil
    import pytesseract

    # tesseract 二进制可能未在 PATH（UB Mannheim 默认装到 C:\Program Files\Tesseract-OCR）
    # 首选 OCR_TESSERACT_BIN 环境变量（换机器/换安装位置无需改代码），其次常见安装路径
    _env_bin = os.environ.get("OCR_TESSERACT_BIN", "")
    _candidates = [p for p in [_env_bin] if p] + [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    _found = next((p for p in _candidates if os.path.isfile(p)), None)
    if _found and not shutil.which("tesseract"):
        pytesseract.pytesseract.tesseract_cmd = _found

    # 词库用 AndroidOCR 自带的 traineddata（含 eng + chi_sim）。
    # 本版 tesseract 会把 TESSDATA_PREFIX 直接当作 tessdata 目录（其后拼 xxx.traineddata），
    # 所以指向 tessdata 本身而非父目录。
    # 目录可用 OCR_TESSDATA_DIR 覆盖（默认值为仓库内 AndroidOCR 源码包路径）。
    tessdata = os.environ.get(
        "OCR_TESSDATA_DIR",
        "D:/AllSideProject/AICorrection/AndroidOCR-master/app/src/main/assets/tessdata",
    )
    if os.path.isdir(tessdata):
        os.environ["TESSDATA_PREFIX"] = tessdata + os.sep

    with _SilenceStdout():
        t0 = time.time()
        raw = pytesseract.image_to_string(img, lang="chi_sim+eng")
        wall = time.time() - t0

    # Tesseract 无置信度/坐标，按行输出；score 置 None 保持字段一致
    lines = [ln.strip() for ln in raw.splitlines()]
    texts = [{"text": ln, "score": None, "box": None} for ln in lines if ln]
    return texts, wall, wall


def run_serve() -> None:
    """常驻服务模式（P1-b）：模型只加载一次，之后每个请求复用同一进程。

    启动时一次性加载 RapidOCR / PP-FormulaNet-S / Paddle 文本引擎并缓存到模块全局，
    全部就绪后打印一行 {"ready":true,"engine":"serve"} 并 flush。
    随后循环从 stdin 读一行请求 JSON {"id"?, "engine", "image", "formula"} 直到 EOF；
    对每个请求复用缓存引擎，构建与单次模式完全相同的 payload，向 stdout 写恰好一行
    {"req":<原样回显的请求>,"payload":<payload>} 并 flush。EOF 后退出 0。
    """
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        # 一次性加载并缓存全部引擎
        _get_rapid()
        _get_formula()
        _get_paddle()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ready": False, "error": str(e)}), flush=True)
        sys.exit(1)

    print(json.dumps({"ready": True, "engine": "serve"}), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:  # noqa: BLE001
            continue  # 丢弃无法解析的行

        engine = req.get("engine", "rapid")
        image = req.get("image", "")
        formula = bool(req.get("formula", False))

        try:
            if engine == "rapid":
                texts, elapse, wall = run_rapid(image, formula)
            elif engine == "tesseract":
                texts, elapse, wall = run_tesseract(image, formula)
            else:
                texts, elapse, wall = run_paddle(image, formula)
            payload = {
                "ok": True,
                "engine": engine,
                "formula": formula,
                "elapsed_wall": round(wall, 3),
                "elapsed_engine": round(float(elapse), 3),
                "count": len(texts),
                "texts": texts,
            }
        except Exception as e:  # noqa: BLE001
            payload = {
                "ok": False,
                "engine": engine,
                "formula": formula,
                "error": str(e),
            }

        # 每个请求恰好写一行；原样回显 req（含 id，供 Node 端按 id 关联响应）
        out = {"req": req, "payload": payload}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    sys.exit(0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["rapid", "paddle", "tesseract"], default="rapid")
    ap.add_argument("--image", default=None)
    ap.add_argument("--formula", action="store_true")
    ap.add_argument("--serve", action="store_true")
    args = ap.parse_args()

    # 服务模式：模型只加载一次，常驻进程处理所有请求（见 run_serve）
    if args.serve:
        run_serve()
        return

    if not args.image:
        payload = {
            "ok": False,
            "engine": args.engine,
            "formula": args.formula,
            "error": "单次模式必须提供 --image",
        }
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False))
        return

    try:
        if args.formula and args.engine != "paddle":
            raise RuntimeError(
                f"公式识别仅 paddle 引擎支持（PP-FormulaNet-S），当前 engine={args.engine}"
            )
        if args.engine == "rapid":
            texts, elapse, wall = run_rapid(args.image, args.formula)
        elif args.engine == "tesseract":
            texts, elapse, wall = run_tesseract(args.image, args.formula)
        else:
            texts, elapse, wall = run_paddle(args.image, args.formula)
        payload = {
            "ok": True,
            "engine": args.engine,
            "formula": args.formula,
            "elapsed_wall": round(wall, 3),
            "elapsed_engine": round(float(elapse), 3),
            "count": len(texts),
            "texts": texts,
        }
    except Exception as e:  # noqa: BLE001
        payload = {"ok": False, "engine": args.engine, "formula": args.formula, "error": str(e)}

    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
