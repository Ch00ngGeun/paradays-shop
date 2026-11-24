from __future__ import annotations

import math
from collections.abc import Mapping
from numbers import Number
from typing import Any, Final

MAX_OCR_TEXT_CHARACTERS: Final = 512


MAX_BOUNDING_COORDINATE: Final = 1_000_000


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
