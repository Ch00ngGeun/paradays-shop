"""In-memory PaddleOCR execution and narrow provider-response adaptation.

This module deliberately has no Paddle, NumPy, or OpenCV import at module load
time. The service can therefore retain a live health endpoint when its optional
OCR runtime is absent or cannot preload.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from numbers import Number
from typing import Any, Final

from .image_validation import MAX_IMAGE_PIXELS, ValidatedOcrImage


MAX_OCR_ROWS: Final = 500
# Lambda applies its per-text and combined raw-text limits with JavaScript
# UTF-16 string lengths, not Python code-point counts.
MAX_OCR_TEXT_CHARACTERS: Final = 512
MAX_RAW_TEXT_CHARACTERS: Final = 100_000
MAX_BOUNDING_COORDINATE: Final = 1_000_000
# Leave margin below the Lambda provider-response ceiling of 2 MiB.
MAX_CANONICAL_RESPONSE_BYTES: Final = 1_800_000


class OcrInferenceError(RuntimeError):
    """A safe, generic OCR runtime failure with no provider details attached."""


class OcrInputDecodeError(ValueError):
    """Allowed-format bytes could not be safely decoded as their claimed image."""


def preload_ocr_engine(model_language: str) -> Any:
    """Create the one process-shared PaddleOCR engine during application startup."""

    if not isinstance(model_language, str) or not model_language:
        raise OcrInferenceError

    try:
        # Use the validated conservative CPU pipeline. Product-list images do not
        # need optional document transforms; requests never supply paths or URLs.
        from paddleocr import PaddleOCR

        return PaddleOCR(
            lang=model_language,
            device="cpu",
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except Exception:
        raise OcrInferenceError from None


def run_ocr_in_memory(engine: Any, image: ValidatedOcrImage) -> dict[str, Any]:
    """Decode a validated image in memory and expose only the Lambda contract."""

    try:
        decoded_image = _decode_image_in_memory(image)
        raw_result, api_generation = _invoke_engine(engine, decoded_image)

        if api_generation == 3:
            canonical = _canonicalize_v3_result(raw_result)
        else:
            canonical = _canonicalize_v2_result(raw_result)

        _assert_bounded_canonical_response(canonical)
        return canonical
    except OcrInputDecodeError:
        raise
    except OcrInferenceError:
        raise
    except Exception:
        # Do not retain exception chains that can disclose model, file, or input
        # details through an upstream logger or error handler.
        raise OcrInferenceError from None


def _decode_image_in_memory(image: ValidatedOcrImage) -> Any:
    """Use an ndarray input, never a request-derived file path or temporary file."""

    try:
        import cv2
        import numpy as np
    except Exception:
        raise OcrInferenceError from None

    try:
        encoded = np.frombuffer(image.data, dtype=np.uint8)
        decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    except Exception:
        raise OcrInputDecodeError from None

    if decoded is None or not hasattr(decoded, "shape") or len(decoded.shape) < 2:
        raise OcrInputDecodeError

    try:
        height = int(decoded.shape[0])
        width = int(decoded.shape[1])
    except (TypeError, ValueError, OverflowError, IndexError):
        raise OcrInputDecodeError from None

    # Header dimensions are checked before decoder allocation. Confirm the
    # decoded raster agrees before it ever reaches the model.
    if (
        width <= 0
        or height <= 0
        or width != image.width
        or height != image.height
        or width * height > MAX_IMAGE_PIXELS
    ):
        raise OcrInputDecodeError

    return decoded


def _invoke_engine(engine: Any, image: Any) -> tuple[Any, int]:
    """Call the 3.x ndarray API first, with a minimal legacy 2.x fallback."""

    predict = getattr(engine, "predict", None)

    try:
        if callable(predict):
            return predict(image), 3

        legacy_ocr = getattr(engine, "ocr", None)

        if callable(legacy_ocr):
            # ``cls`` is supported by the established 2.x PaddleOCR surface and
            # avoids accepting source paths or URLs as an input compatibility aid.
            return legacy_ocr(image, cls=False), 2
    except Exception:
        raise OcrInferenceError from None

    raise OcrInferenceError


def _canonicalize_v3_result(raw_result: Any) -> dict[str, Any]:
    """Adapt one PaddleOCR 3.x prediction record into the fixed provider shape."""

    record = _first_v3_result(raw_result)
    payload = _find_ocr_payload(_mapping_from_result(record))

    texts = _to_sequence(payload.get("rec_texts"))
    scores = _to_sequence(payload.get("rec_scores"))

    if texts is None or scores is None:
        raise OcrInferenceError

    boxes = _to_sequence(payload.get("rec_boxes")) or []
    polys = _to_sequence(payload.get("rec_polys")) or []

    return _canonicalize_parallel_rows(texts, scores, boxes, polys)


def _canonicalize_v2_result(raw_result: Any) -> dict[str, Any]:
    """Adapt legacy PaddleOCR 2.x nested line output without shifting rows."""

    outer = _to_sequence(raw_result)

    if outer is None:
        raise OcrInferenceError

    if not outer or outer[0] is None:
        return _build_canonical_response([], [], [])

    if _looks_like_legacy_line(outer[0]):
        lines = outer
    else:
        lines = _to_sequence(outer[0])

        if lines is None:
            raise OcrInferenceError

    texts: list[Any] = []
    scores: list[Any] = []
    boxes: list[Any] = []

    for line in lines[:MAX_OCR_ROWS]:
        line_values = _to_sequence(line)

        if line_values is None or len(line_values) < 2:
            texts.append(None)
            scores.append(None)
            boxes.append(None)
            continue

        text_score = _to_sequence(line_values[1])

        if text_score is None or len(text_score) < 2:
            texts.append(None)
            scores.append(None)
            boxes.append(line_values[0])
            continue

        texts.append(text_score[0])
        scores.append(text_score[1])
        boxes.append(line_values[0])

    return _canonicalize_parallel_rows(texts, scores, boxes, [])


def _first_v3_result(raw_result: Any) -> Any:
    """Read only the first record for the single image input accepted by this API."""

    if raw_result is None:
        raise OcrInferenceError

    if _mapping_from_result(raw_result) is not None:
        return raw_result

    values = _to_sequence(raw_result)

    if values is not None:
        if not values:
            raise OcrInferenceError
        return values[0]

    try:
        iterator = iter(raw_result)
        return next(iterator)
    except (StopIteration, TypeError):
        raise OcrInferenceError from None


def _mapping_from_result(value: Any) -> Mapping[str, Any] | None:
    """Extract a dict or a 3.x result object's safe JSON/dict representation."""

    if isinstance(value, Mapping):
        return value

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, Mapping) else None

    if isinstance(value, (bytes, bytearray)):
        return None

    for attribute in ("json", "to_dict", "dict"):
        try:
            candidate = getattr(value, attribute)
            candidate = candidate() if callable(candidate) else candidate
        except Exception:
            continue

        if candidate is value:
            continue

        mapping = _mapping_from_result(candidate)

        if mapping is not None:
            return mapping

    return None


def _find_ocr_payload(mapping: Mapping[str, Any] | None) -> Mapping[str, Any]:
    """Locate recognition fields in a narrow set of known Paddle 3.x wrappers."""

    if mapping is None:
        raise OcrInferenceError

    if "rec_texts" in mapping or "rec_scores" in mapping:
        return mapping

    for key in ("res", "result", "data"):
        candidate = _mapping_from_result(mapping.get(key))

        if candidate is not None and (
            "rec_texts" in candidate or "rec_scores" in candidate
        ):
            return candidate

    raise OcrInferenceError


def _canonicalize_parallel_rows(
    texts: list[Any],
    scores: list[Any],
    boxes: list[Any],
    polys: list[Any],
) -> dict[str, Any]:
    """Filter complete text/score rows while keeping geometry at its source index."""

    canonical_texts: list[str] = []
    canonical_scores: list[float] = []
    canonical_boxes: list[list[list[float]]] = []
    raw_text_length = 0
    row_count = min(len(texts), len(scores), MAX_OCR_ROWS)

    for index in range(row_count):
        text = _safe_text(texts[index])
        score = _safe_score(scores[index])

        # A row missing text or a valid confidence is removed as a complete row;
        # its box is never paired with a later source row.
        if text is None or score is None:
            continue

        # Mirror Lambda's `rec_texts.join("\n").length <= 100_000` guard. Stop
        # at the first over-limit source row to keep the accepted row/box pairing
        # deterministic instead of emitting a provider success Lambda will reject.
        separator_length = 1 if canonical_texts else 0
        next_raw_text_length = raw_text_length + separator_length + _utf16_length(text)

        if next_raw_text_length > MAX_RAW_TEXT_CHARACTERS:
            break

        box = _normalize_box(boxes[index]) if index < len(boxes) else None
        poly = _normalize_box(polys[index]) if index < len(polys) else None

        canonical_texts.append(text)
        canonical_scores.append(score)
        raw_text_length = next_raw_text_length
        # This mirrors schemas.py: a usable box wins; only its same-index fallback
        # polygon may replace a missing/malformed box, otherwise the slot is empty.
        canonical_boxes.append(box or poly or [])

    return _build_canonical_response(canonical_texts, canonical_scores, canonical_boxes)


def _build_canonical_response(
    texts: list[str], scores: list[float], boxes: list[list[list[float]]]
) -> dict[str, Any]:
    """Build exactly the provider envelope consumed by the Lambda adapter."""

    return {
        "result": {
            "ocrResults": [
                {
                    "prunedResult": {
                        "rec_texts": texts,
                        "rec_scores": scores,
                        "rec_boxes": boxes,
                    }
                }
            ]
        }
    }


def _looks_like_legacy_line(value: Any) -> bool:
    """Distinguish a direct legacy line list from its single-image outer list."""

    values = _to_sequence(value)

    if values is None or len(values) < 2:
        return False

    text_score = _to_sequence(values[1])
    return (
        _normalize_box(values[0]) is not None
        and text_score is not None
        and len(text_score) >= 2
        and type(text_score[0]) is str
    )


def _to_sequence(value: Any) -> list[Any] | None:
    """Convert only list-like engine outputs to plain lists, never strings/maps."""

    if isinstance(value, (str, bytes, bytearray, Mapping)):
        return None

    if isinstance(value, (list, tuple)):
        return list(value)

    to_list = getattr(value, "tolist", None)

    if callable(to_list):
        try:
            converted = to_list()
        except Exception:
            return None

        if converted is value:
            return None

        return _to_sequence(converted)

    return None


def _safe_text(value: Any) -> str | None:
    """Keep nonempty, bounded UTF-8 text using Lambda's UTF-16 length rules."""

    if type(value) is not str:
        return None

    text = value.strip()

    if not text:
        return None

    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return None

    return _truncate_utf16(text, MAX_OCR_TEXT_CHARACTERS)


def _truncate_utf16(value: str, limit: int) -> str:
    """Truncate at a code-point boundary while counting JS UTF-16 code units."""

    result: list[str] = []
    used = 0

    for character in value:
        units = 2 if ord(character) > 0xFFFF else 1

        if used + units > limit:
            break

        result.append(character)
        used += units

    return "".join(result)


def _utf16_length(value: str) -> int:
    """Return the string length JavaScript uses for Lambda's contract guard."""

    return sum(2 if ord(character) > 0xFFFF else 1 for character in value)


def _safe_score(value: Any) -> float | None:
    """Return only finite primitive numeric confidence values in the 0..1 range."""

    value = _unwrap_scalar(value)

    if isinstance(value, bool) or not isinstance(value, Number):
        return None

    try:
        score = float(value)
    except (TypeError, ValueError, OverflowError):
        return None

    if not math.isfinite(score) or not 0.0 <= score <= 1.0:
        return None

    return score


def _normalize_box(value: Any) -> list[list[float]] | None:
    """Mirror schemas.py/Lambda geometry rules and convert NumPy values to floats."""

    values = _to_sequence(value)

    if values is None:
        return None

    if len(values) == 4:
        flat = [_safe_coordinate(coordinate) for coordinate in values]

        if all(coordinate is not None for coordinate in flat):
            left, top, right, bottom = flat
            return [
                [left, top],
                [right, top],
                [right, bottom],
                [left, bottom],
            ]

    if len(values) < 2 or len(values) > 8:
        return None

    polygon: list[list[float]] = []

    for point in values:
        coordinates = _to_sequence(point)

        if coordinates is None or len(coordinates) < 2:
            return None

        x = _safe_coordinate(coordinates[0])
        y = _safe_coordinate(coordinates[1])

        if x is None or y is None:
            return None

        polygon.append([x, y])

    return polygon


def _safe_coordinate(value: Any) -> float | None:
    """Normalize an allowed finite geometry coordinate to a JSON primitive."""

    value = _unwrap_scalar(value)

    if isinstance(value, bool) or not isinstance(value, Number):
        return None

    try:
        coordinate = float(value)
    except (TypeError, ValueError, OverflowError):
        return None

    if not math.isfinite(coordinate) or abs(coordinate) > MAX_BOUNDING_COORDINATE:
        return None

    return coordinate


def _unwrap_scalar(value: Any) -> Any:
    """Convert NumPy scalar-like values to Python values without importing NumPy."""

    if isinstance(value, (str, bytes, bytearray, bool, int, float)):
        return value

    item = getattr(value, "item", None)

    if callable(item):
        try:
            converted = item()
        except Exception:
            return value

        if converted is not value:
            return converted

    return value


def _assert_bounded_canonical_response(response: dict[str, Any]) -> None:
    """Fail closed rather than exceed the Lambda provider response budget."""

    try:
        encoded = json.dumps(
            response,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        raise OcrInferenceError from None

    if len(encoded) > MAX_CANONICAL_RESPONSE_BYTES:
        raise OcrInferenceError
