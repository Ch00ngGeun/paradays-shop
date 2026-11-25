# 역할: 검증된 이미지를 메모리 안에서 PaddleOCR로 인식하고 Lambda가 기대하는 provider 응답으로 좁혀 변환함.
"""In-memory PaddleOCR execution and narrow provider-response adaptation.

This module deliberately has no Paddle, NumPy, or OpenCV import at module load
time. The service can therefore retain a live health endpoint when its optional
OCR runtime is absent or cannot preload.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final

from .image_validation import MAX_IMAGE_PIXELS, ValidatedOcrImage
from .ocr_engine_values import (
    _looks_like_legacy_line,
    _normalize_box,
    _safe_score,
    _safe_text,
    _to_sequence,
    _utf16_length,
)


MAX_OCR_ROWS: Final = 500
# Lambda는 텍스트별·전체 원문 길이 한도를 Python code point 수가 아니라
# JavaScript UTF-16 문자열 길이로 적용함.
MAX_RAW_TEXT_CHARACTERS: Final = 100_000
# Lambda provider 응답 상한 2 MiB보다 여유를 두고 작게 잡음.
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
        # 검증된 보수적 CPU pipeline을 씀. 상품 목록 이미지에는 선택적 문서 변환이
        # 필요 없고, 요청은 경로나 URL을 절대 넘기지 않음.
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
        # 상위 logger나 오류 처리기를 통해 model·파일·입력 정보가 드러날 수 있는
        # 예외 chain을 남기지 않음.
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

    # header 크기는 디코더 할당 전에 확인함. model에 넘기기 전에
    # 디코딩된 raster 크기도 일치하는지 확인함.
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
            # ``cls``는 기존 2.x PaddleOCR 호출 형태가 지원하며, 입력 호환을 이유로
            # 원본 경로나 URL을 받아들이지 않게 함.
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

        # 텍스트나 유효한 신뢰도가 없는 행은 행 전체를 제거하며,
        # 그 box를 뒤쪽 원본 행과 짝짓지 않음.
        if text is None or score is None:
            continue

        # Lambda의 `rec_texts.join("\n").length <= 100_000` 검사와 맞춤. Lambda가 거부할
        # provider 성공 응답을 내보내는 대신, 한도를 넘는 첫 원본 행에서 멈춰
        # 채택된 행/box 짝을 결정적으로 유지함.
        separator_length = 1 if canonical_texts else 0
        next_raw_text_length = raw_text_length + separator_length + _utf16_length(text)

        if next_raw_text_length > MAX_RAW_TEXT_CHARACTERS:
            break

        box = _normalize_box(boxes[index]) if index < len(boxes) else None
        poly = _normalize_box(polys[index]) if index < len(polys) else None

        canonical_texts.append(text)
        canonical_scores.append(score)
        raw_text_length = next_raw_text_length
        # schemas.py와 같은 규칙임: 쓸 수 있는 box를 우선하고, 없거나 잘못된 box만
        # 같은 index의 대체 polygon으로 바꾸며, 그것도 없으면 빈 칸으로 둠.
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
