"""PaddleOCR provider payloads exposed by the private OCR service."""

from __future__ import annotations

from math import isfinite
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


Polygon = list[list[float]]
MAX_BOUNDING_COORDINATE = 1_000_000


def _is_bounding_coordinate(value: Any) -> bool:
    """Match the coordinate guard used by Lambda's readBoundingBox."""

    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and abs(value) <= MAX_BOUNDING_COORDINATE
        and isfinite(value)
    )


def _read_bounding_box(value: Any) -> Polygon | None:
    """Normalize only geometry that Lambda's readBoundingBox would accept."""

    if not isinstance(value, list):
        return None

    # PaddleOCR may supply native [left, top, right, bottom] boxes.
    if len(value) == 4 and all(
        _is_bounding_coordinate(coordinate) for coordinate in value
    ):
        left, top, right, bottom = value
        return [
            [left, top],
            [right, top],
            [right, bottom],
            [left, bottom],
        ]

    if len(value) < 2 or len(value) > 8:
        return None

    points: Polygon = []

    for point in value:
        if (
            not isinstance(point, list)
            or len(point) < 2
            or not _is_bounding_coordinate(point[0])
            or not _is_bounding_coordinate(point[1])
        ):
            return None

        # Lambda retains only x/y when a provider includes extra point fields.
        points.append([point[0], point[1]])

    return points


def _is_polygon(value: Any) -> bool:
    """Check the provider value before letting it occupy a canonical box slot."""

    return _read_bounding_box(value) is not None


class PaddleOcrResponse(BaseModel):
    """Return only the Lambda OCR contract, mapping provider polygons to boxes."""

    model_config = ConfigDict(extra="ignore")

    rec_texts: list[str]
    rec_scores: list[float]
    rec_boxes: list[Polygon] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def normalize_rec_boxes(cls, value: Any) -> Any:
        """Keep canonical boxes and fill only missing or malformed slots from polygons."""

        if not isinstance(value, dict):
            return value

        normalized = dict(value)
        polys = normalized.pop("rec_polys", None)
        boxes = normalized.get("rec_boxes")

        if not isinstance(boxes, list):
            boxes = []

        if not isinstance(polys, list):
            polys = []

        merged_boxes: list[Any] = []

        for index in range(max(len(boxes), len(polys))):
            box = _read_bounding_box(boxes[index]) if index < len(boxes) else None
            poly = _read_bounding_box(polys[index]) if index < len(polys) else None

            if box is not None:
                merged_boxes.append(box)
            elif poly is not None:
                merged_boxes.append(poly)
            else:
                # Keep later entries at their source index; Lambda ignores this slot.
                merged_boxes.append([])

        normalized["rec_boxes"] = merged_boxes
        return normalized
