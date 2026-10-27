#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
路线 B —— PaddleOCR（CPU 传统方案，非视觉大模型）最小验证脚本。

覆盖两件事：
  1) 通用中文文字识别（PP-OCR 系列，检测 + 方向分类 + 识别）
  2) 公式识别（PP-FormulaNet-S，输出 LaTeX）—— 错题场景最关心的能力

用法
----
  .venv-ocr/Scripts/python.exe scripts/ocr/paddleocr_verify.py              # 文字 + 公式
  .venv-ocr/Scripts/python.exe scripts/ocr/paddleocr_verify.py --text-only  # 只跑文字
  .venv-ocr/Scripts/python.exe scripts/ocr/paddleocr_verify.py --formula-only
  .venv-ocr/Scripts/python.exe scripts/ocr/paddleocr_verify.py --json       # 纯 JSON

依赖安装
--------
  .venv-ocr/Scripts/python.exe -m pip install paddlepaddle paddleocr \
      -i https://pypi.tuna.tsinghua.edu.cn/simple

说明
----
- 首次运行会自动下载推理模型到 ~/.paddlex/official_models（日志里会打印下载内容）
- 本脚本记录：文字识别结果 / 公式 LaTeX / 冷启动时延 / 单图时延
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

_SCRIPT_DIR = Path(__file__).resolve().parent
_SAMPLES_ROOT = _SCRIPT_DIR.parents[2]
PADDLE_TESTS = _SAMPLES_ROOT / "PaddleOCR-main" / "tests" / "test_files"
RAPID_TESTS = _SAMPLES_ROOT / "RapidOCR-main" / "python" / "tests" / "test_files"

# 文字识别样例：中文图（与路线 A 共用的 ch_en_num.jpg）+ 英文书页
TEXT_IMAGES: list[Path] = [
    RAPID_TESTS / "ch_en_num.jpg",   # 中文主样例（有明确 ground truth）
    PADDLE_TESTS / "book.jpg",       # 英文书页
]
# 公式识别样例
FORMULA_IMAGES: list[Path] = [
    PADDLE_TESTS / "formula.png",
    PADDLE_TESTS / "doc_with_formula.png",
]


def _to_jsonable(obj: Any) -> Any:
    if obj is None:
        return None
    if hasattr(obj, "tolist"):
        return obj.tolist()
    if isinstance(obj, (list, tuple)):
        return [_to_jsonable(x) for x in obj]
    return obj


def extract_text_lines(raw: Any) -> list[dict[str, Any]]:
    """兼容 PaddleOCR 2.x / 3.x 两种返回结构。"""
    lines: list[dict[str, Any]] = []

    # --- 3.x：predict() 返回 Result 对象序列，带 rec_texts / rec_scores / rec_polys ---
    def from_result_obj(res: Any) -> bool:
        if not hasattr(res, "rec_texts"):
            return False
        # rec_polys 是 numpy 数组，不能用 `or []` 判空（ambiguous truth value）
        texts = (
            list(res.rec_texts) if getattr(res, "rec_texts", None) is not None else []
        )
        scores = (
            list(res.rec_scores) if getattr(res, "rec_scores", None) is not None else []
        )
        polys = (
            list(res.rec_polys) if getattr(res, "rec_polys", None) is not None else []
        )
        for i, t in enumerate(texts):
            lines.append(
                {
                    "text": str(t),
                    "score": float(scores[i]) if i < len(scores) else None,
                    "box": _to_jsonable(polys[i]) if i < len(polys) else None,
                }
            )
        return True

    if isinstance(raw, (list, tuple)):
        for item in raw:
            if from_result_obj(item):
                continue
            # --- 2.x：[[ [box, (text, score)], ... ]] ---
            if isinstance(item, (list, tuple)):
                for line in item:
                    try:
                        box = line[0]
                        text, score = line[1][0], line[1][1]
                    except Exception:
                        continue
                    lines.append(
                        {"text": str(text), "score": float(score), "box": _to_jsonable(box)}
                    )
    else:
        from_result_obj(raw)
    return lines


def run_text(imgs: list[Path]) -> dict[str, Any]:
    """通用文字识别。"""
    from paddleocr import PaddleOCR

    t0 = time.perf_counter()
    try:
        # 3.x 参数名
        ocr = PaddleOCR(
            lang="ch",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        api = "3.x"
    except TypeError:
        # 2.x 回退
        ocr = PaddleOCR(use_angle_cls=True, lang="ch")
        api = "2.x"
    init_ms = (time.perf_counter() - t0) * 1000.0

    items: list[dict[str, Any]] = []
    for p in imgs:
        t1 = time.perf_counter()
        if api == "3.x":
            raw = ocr.predict(str(p))
        else:
            raw = ocr.ocr(str(p), cls=True)
        elapsed = (time.perf_counter() - t1) * 1000.0

        lines = extract_text_lines(raw)
        items.append(
            {
                "image": str(p),
                "elapsed_ms": round(elapsed, 2),
                "line_count": len(lines),
                "text": "\n".join(x["text"] for x in lines),
                "lines": lines,
            }
        )

    return {"api": api, "engine_init_ms": round(init_ms, 2), "items": items}


def run_formula(imgs: list[Path]) -> dict[str, Any]:
    """公式识别 → LaTeX。"""
    from paddleocr import FormulaRecognition

    t0 = time.perf_counter()
    model = FormulaRecognition(model_name="PP-FormulaNet-S")
    init_ms = (time.perf_counter() - t0) * 1000.0

    items: list[dict[str, Any]] = []
    for p in imgs:
        t1 = time.perf_counter()
        output = model.predict(input=str(p))
        elapsed = (time.perf_counter() - t1) * 1000.0

        latex = ""
        try:
            for res in output:
                # 3.x Result 对象通常有 rec_formula 或 json['rec_formula']
                if hasattr(res, "rec_formula"):
                    latex = str(res.rec_formula)
                elif isinstance(res, dict) and "rec_formula" in res:
                    latex = str(res["rec_formula"])
                elif isinstance(res, dict):
                    latex = json.dumps(res, ensure_ascii=False)[:500]
                if latex:
                    break
        except Exception as e:  # pragma: no cover
            latex = f"<解析失败: {type(e).__name__}: {e}>"

        items.append({"image": str(p), "elapsed_ms": round(elapsed, 2), "latex": latex})

    return {"model": "PP-FormulaNet-S", "engine_init_ms": round(init_ms, 2), "items": items}


def main() -> int:
    ap = argparse.ArgumentParser(description="PaddleOCR CPU 传统 OCR 验证脚本")
    ap.add_argument("--text-only", action="store_true", help="只跑通用文字识别")
    ap.add_argument("--formula-only", action="store_true", help="只跑公式识别")
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    args = ap.parse_args()

    text_imgs = [p for p in TEXT_IMAGES if p.exists()]
    formula_imgs = [p for p in FORMULA_IMAGES if p.exists()]

    payload: dict[str, Any] = {
        "engine": "paddleocr",
        "python": sys.version.split()[0],
        "text": None,
        "formula": None,
        "errors": [],
    }

    if not args.formula_only:
        try:
            payload["text"] = run_text(text_imgs)
        except Exception as e:
            payload["errors"].append(f"text: {type(e).__name__}: {e}")

    if not args.text_only:
        try:
            payload["formula"] = run_formula(formula_imgs)
        except Exception as e:
            payload["errors"].append(f"formula: {type(e).__name__}: {e}")

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if not payload["errors"] else 1

    print("=" * 78)
    print(f"PaddleOCR 验证 | Python {payload['python']}")
    print("=" * 78)

    t = payload["text"]
    if t:
        print(f"\n[通用文字识别] API={t['api']}  引擎初始化={t['engine_init_ms']}ms")
        for it in t["items"]:
            print(f"\n--- {Path(it['image']).name} ({it['elapsed_ms']}ms, {it['line_count']} 行) ---")
            for ln in it["lines"]:
                s = f"{ln['score']:.3f}" if isinstance(ln["score"], float) else "n/a"
                print(f"  [{s}] {ln['text']}")
    else:
        print("\n[通用文字识别] 未执行")

    f = payload["formula"]
    if f:
        print(f"\n[公式识别] model={f['model']}  引擎初始化={f['engine_init_ms']}ms")
        for it in f["items"]:
            print(f"\n--- {Path(it['image']).name} ({it['elapsed_ms']}ms) ---")
            print(f"  LaTeX: {it['latex']}")
    else:
        print("\n[公式识别] 未执行")

    if payload["errors"]:
        print("\n!!! 错误 !!!")
        for e in payload["errors"]:
            print("  " + e)

    print("\n" + "=" * 78)
    print("JSON 输出：")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not payload["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
