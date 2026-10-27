#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
路线 A —— RapidOCR（ONNXRuntime / CPU 传统方案，非视觉大模型）最小验证脚本。

作用
----
把「图片 → 题干文本」真正跑通，并输出结构化 JSON，便于后续喂给 Node 后端。

用法
----
  # 用默认样例图跑
  .venv-ocr/Scripts/python.exe scripts/ocr/rapidocr_verify.py

  # 指定图片
  .venv-ocr/Scripts/python.exe scripts/ocr/rapidocr_verify.py path/to/a.jpg path/to/b.png

  # 纯 JSON 输出（给 Node 后端消费）
  .venv-ocr/Scripts/python.exe scripts/ocr/rapidocr_verify.py --json path/to/a.jpg

输出 JSON 结构
--------------
{
  "engine": "rapidocr",
  "version": "3.x",
  "python": "3.12.7",
  "model_dir": "...",          # 模型实际所在目录（用于确认是否额外下载）
  "results": [
    {
      "image": "abs/path",
      "elapsed_ms": 234.5,     # 纯推理耗时（不含引擎初始化）
      "cold_ms": 1820.3,       # 首次调用耗时（含模型加载/预热）
      "line_count": 7,
      "text": "拼接后的纯文本",
      "lines": [{"text": "...", "score": 0.98, "box": [[x,y],...]}]
    }
  ]
}

依赖安装
--------
  .venv-ocr/Scripts/python.exe -m pip install rapidocr onnxruntime \
      -i https://pypi.tuna.tsinghua.edu.cn/simple
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# Windows 控制台默认 GBK，中文结果会 UnicodeEncodeError，强制 UTF-8 输出。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 非 Windows 或不支持重配置时忽略
    pass


# ---------------------------------------------------------------------------
# 样例图定位：脚本位于 <root>/aicorrection-v0.1/scripts/ocr/
# parents[0]=ocr, [1]=scripts, [2]=aicorrection-v0.1, [3]=AICorrection(样例根)
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
_SAMPLES_ROOT = _SCRIPT_DIR.parents[2]
PADDLE_TESTS = _SAMPLES_ROOT / "PaddleOCR-main" / "tests" / "test_files"
RAPID_TESTS = _SAMPLES_ROOT / "RapidOCR-main" / "python" / "tests" / "test_files"

DEFAULT_IMAGES: list[Path] = [
    PADDLE_TESTS / "book.jpg",          # 中文书页（与路线 B 共用，便于横向对比）
    PADDLE_TESTS / "textline.png",      # 单行文本
    RAPID_TESTS / "ch_en_num.jpg",      # 中英数混排
    RAPID_TESTS / "en.jpg",             # 纯英文
]


def build_engine() -> tuple[Any, str]:
    """构造 RapidOCR 引擎，兼容新旧两代包名/返回结构。返回 (engine, 版本说明)。"""
    try:
        from rapidocr import RapidOCR  # rapidocr >= 3.x

        pkg = "rapidocr"
    except ImportError:  # pragma: no cover - 旧版本回退
        from rapidocr_onnxruntime import RapidOCR  # rapidocr <= 2.x

        pkg = "rapidocr_onnxruntime"

    try:
        from importlib.metadata import version as _pkg_version

        ver = _pkg_version(pkg)
    except Exception:
        ver = "unknown"

    return RapidOCR(), f"{pkg}=={ver}"


def normalize(raw: Any) -> list[dict[str, Any]]:
    """把不同版本 RapidOCR 的返回统一成 [{'text','score','box'}...]。"""
    if raw is None:
        return []

    # 新版本返回对象，带 .txts / .scores / .boxes
    # 注意：boxes 是 numpy 数组，不能用 `or []` 判空（会抛
    # "truth value of an array ... is ambiguous"），必须显式判 None
    if hasattr(raw, "txts"):
        txts = list(raw.txts) if getattr(raw, "txts", None) is not None else []
        scores = (
            list(raw.scores) if getattr(raw, "scores", None) is not None else []
        )
        boxes = list(raw.boxes) if getattr(raw, "boxes", None) is not None else []
        out: list[dict[str, Any]] = []
        for i, t in enumerate(txts):
            out.append(
                {
                    "text": str(t),
                    "score": float(scores[i]) if i < len(scores) else None,
                    "box": _to_jsonable(boxes[i]) if i < len(boxes) else None,
                }
            )
        return out

    # 旧版本返回 list[[box, text, score], ...]
    out = []
    for item in raw:
        try:
            box, text, score = item[0], item[1], item[2]
        except Exception:
            continue
        out.append({"text": str(text), "score": float(score), "box": _to_jsonable(box)})
    return out


def _to_jsonable(obj: Any) -> Any:
    """numpy 数组等转成可 JSON 序列化的普通结构。"""
    if obj is None:
        return None
    if hasattr(obj, "tolist"):
        return obj.tolist()
    if isinstance(obj, (list, tuple)):
        return [_to_jsonable(x) for x in obj]
    return obj


def locate_models() -> str:
    """报告模型文件实际位置，用于确认是否有额外下载。"""
    try:
        import rapidocr

        return str(Path(rapidocr.__file__).parent)
    except Exception:
        return "unknown"


def run_one(engine: Any, img: Path) -> dict[str, Any]:
    """对单张图执行 OCR，返回结构化结果（含冷/热耗时）。"""
    t0 = time.perf_counter()
    raw = engine(str(img))
    cold_ms = (time.perf_counter() - t0) * 1000.0

    # 若返回 (result, elapse) 元组，取 result 部分
    if isinstance(raw, tuple):
        raw = raw[0]

    lines = normalize(raw)

    # 再跑一次取"热"耗时（模型已在内存）
    t1 = time.perf_counter()
    raw2 = engine(str(img))
    elapsed_ms = (time.perf_counter() - t1) * 1000.0
    if isinstance(raw2, tuple):
        raw2 = raw2[0]
    lines = normalize(raw2) or lines

    text = "\n".join(x["text"] for x in lines)
    return {
        "image": str(img),
        "elapsed_ms": round(elapsed_ms, 2),
        "cold_ms": round(cold_ms, 2),
        "line_count": len(lines),
        "text": text,
        "lines": lines,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="RapidOCR CPU 传统 OCR 验证脚本")
    ap.add_argument("images", nargs="*", help="图片路径；留空则用默认样例图")
    ap.add_argument("--json", action="store_true", help="仅输出 JSON（不打印人类可读文本）")
    args = ap.parse_args()

    if args.images:
        imgs = [Path(p) for p in args.images]
    else:
        imgs = [p for p in DEFAULT_IMAGES if p.exists()]
        if not imgs:
            print("未找到默认样例图，请显式传入图片路径。", file=sys.stderr)
            return 2

    missing = [str(p) for p in imgs if not p.exists()]
    if missing:
        print("以下图片不存在：\n  " + "\n  ".join(missing), file=sys.stderr)
        return 2

    engine, version = build_engine()
    results = [run_one(engine, p) for p in imgs]

    payload = {
        "engine": "rapidocr",
        "version": version,
        "python": sys.version.split()[0],
        "model_dir": locate_models(),
        "results": results,
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print("=" * 78)
        print(f"RapidOCR 验证 | {version} | Python {payload['python']}")
        print(f"模型目录：{payload['model_dir']}")
        print("=" * 78)
        for r in results:
            print(f"\n--- {Path(r['image']).name} ---")
            print(f"  行数={r['line_count']}  热耗时={r['elapsed_ms']}ms  冷耗时={r['cold_ms']}ms")
            for ln in r["lines"]:
                score = ln["score"]
                s = f"{score:.3f}" if isinstance(score, float) else "n/a"
                print(f"  [{s}] {ln['text']}")
            if r["line_count"] == 0:
                print("  (未识别到任何文本)")
        print("\n" + "=" * 78)
        print("JSON 输出：")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
