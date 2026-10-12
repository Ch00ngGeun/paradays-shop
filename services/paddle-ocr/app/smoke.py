"""Opt-in, in-memory real-model smoke check for the PaddleOCR service image.

It is deliberately not imported by the API or Docker build. Running the console
script may initialize PaddleOCR and obtain a model according to the installed
PaddleOCR runtime; routine image builds never perform that work.
"""

from __future__ import annotations

import base64
import json
import math
import sys
from typing import Any

from .image_validation import validate_base64_image
from .ocr_engine import (
    MAX_BOUNDING_COORDINATE,
    MAX_OCR_TEXT_CHARACTERS,
    MAX_RAW_TEXT_CHARACTERS,
    preload_ocr_engine,
    run_ocr_in_memory,
)
from .settings import get_settings


def _create_text_image() -> bytes:
    """Create a high-contrast textual PNG entirely in memory."""

    import cv2
    import numpy as np

    canvas = np.full((300, 1200, 3), 255, dtype=np.uint8)
    cv2.putText(
        canvas,
        "PARADAYS 123",
        (55, 195),
        cv2.FONT_HERSHEY_SIMPLEX,
        3.1,
        (0, 0, 0),
        6,
        cv2.LINE_AA,
    )
    encoded, buffer = cv2.imencode(".png", canvas)

    if not encoded:
        raise RuntimeError

    return bytes(buffer)


def _assert_canonical_response(value: Any) -> None:
    """Reject any output other than the exact primitive Lambda provider contract."""

    if not isinstance(value, dict) or set(value) != {"result"}:
        raise RuntimeError

    result = value["result"]

    if not isinstance(result, dict) or set(result) != {"ocrResults"}:
        raise RuntimeError

    ocr_results = result["ocrResults"]

    if not isinstance(ocr_results, list) or len(ocr_results) != 1:
        raise RuntimeError

    item = ocr_results[0]

    if not isinstance(item, dict) or set(item) != {"prunedResult"}:
        raise RuntimeError

    pruned_result = item["prunedResult"]

    if not isinstance(pruned_result, dict) or set(pruned_result) != {
        "rec_texts",
        "rec_scores",
        "rec_boxes",
    }:
        raise RuntimeError

    texts = pruned_result["rec_texts"]
    scores = pruned_result["rec_scores"]
    boxes = pruned_result["rec_boxes"]

    if (
        not isinstance(texts, list)
        or not isinstance(scores, list)
        or not isinstance(boxes, list)
        or len(texts) != len(scores)
        or len(texts) != len(boxes)
        or not texts
        or not all(
            type(text) is str
            and text == text.strip()
            and text
            and _utf16_length(text) <= MAX_OCR_TEXT_CHARACTERS
            for text in texts
        )
        or _utf16_length("\n".join(texts)) > MAX_RAW_TEXT_CHARACTERS
        or not all(
            type(score) is float
            and math.isfinite(score)
            and 0.0 <= score <= 1.0
            for score in scores
        )
        or not all(_is_canonical_box(box) for box in boxes)
        or not _contains_only_json_primitives(value)
    ):
        raise RuntimeError

    # In addition to the structural check, reject accidental NumPy/Paddle values
    # that may have a surprising JSON encoder implementation.
    json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _is_canonical_box(value: Any) -> bool:
    """Require [] or the bounded 2–8 point geometry accepted by the Lambda."""

    if value == []:
        return True

    if not isinstance(value, list) or not 2 <= len(value) <= 8:
        return False

    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            return False

        for coordinate in point:
            if (
                isinstance(coordinate, bool)
                or not isinstance(coordinate, (int, float))
                or not math.isfinite(float(coordinate))
                or abs(float(coordinate)) > MAX_BOUNDING_COORDINATE
            ):
                return False

    return True


def _utf16_length(value: str) -> int:
    """Match the string length guard enforced by the Node.js Lambda adapter."""

    return len(value.encode("utf-16-le")) // 2


def _contains_only_json_primitives(value: Any) -> bool:
    """Ensure no raw Paddle object, ndarray, bytes, or model metadata leaks out."""

    if value is None or type(value) in {str, bool, int}:
        return True

    if type(value) is float:
        return math.isfinite(value)

    if isinstance(value, list):
        return all(_contains_only_json_primitives(item) for item in value)

    if isinstance(value, dict):
        return all(
            type(key) is str and _contains_only_json_primitives(item)
            for key, item in value.items()
        )

    return False


def main() -> int:
    """Run the opt-in engine smoke test without printing input or internal details."""

    try:
        image_bytes = _create_text_image()
        image = validate_base64_image(base64.b64encode(image_bytes).decode("ascii"))
        settings = get_settings()
        engine = preload_ocr_engine(settings.model_language)
        response = run_ocr_in_memory(engine, image)
        _assert_canonical_response(response)
    except Exception:
        print("PaddleOCR smoke failed", file=sys.stderr)
        return 1

    print("PaddleOCR smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
