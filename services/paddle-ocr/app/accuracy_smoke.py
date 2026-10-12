"""Opt-in exact cell accuracy check; never print OCR outside the table ROI.

Run this file against the existing image's app package via PYTHONPATH=/app.
The fixture is a generated sample, not evidence of real intake accuracy.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sys


def normalize(value: str) -> str:
    """Collapse whitespace only; preserve case, punctuation and digits."""
    return " ".join(value.split())


def distance(reference: str, actual: str) -> int:
    previous = list(range(len(actual) + 1))
    for i, left in enumerate(reference, 1):
        current = [i]
        for j, right in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def validate_spec(spec: dict) -> None:
    if spec["scope"] != "gemini-generated-sample-table-only":
        raise ValueError
    if spec["image_size"] != [1024, 1025]:
        raise ValueError
    if spec["columns"] != [186, 339, 730, 836, 970]:
        raise ValueError
    if spec["row_boundaries"] != [461, 526, 594, 661, 729, 802, 877]:
        raise ValueError
    if spec["fields"] != ["code", "product", "quantity", "status"]:
        raise ValueError
    if spec["comparison_policy"] != {
        "strict": "unicode-whitespace-collapse",
        "acceptance_exception": {"field": "status", "ignore": "ASCII U+0020"},
    }:
        raise ValueError
    rows = spec["rows"]
    if len(rows) != 6 or any(len(row) != 4 for row in rows):
        raise ValueError
    if any(not isinstance(cell, str) or not cell or "@" in cell
           for row in rows for cell in row):
        raise ValueError


def assign_cells(canonical: dict, columns: list, boundaries: list) -> list:
    """Assign using geometry alone; expected strings never influence assignment.

    Require full containment in a data cell, excluding headers and surrounding
    UI. Multiple detections in a cell are joined in top-to-bottom/left-to-right
    order. Cross-cell detections are left unassigned, never guessed or split.
    """
    payload = canonical["result"]["ocrResults"][0]["prunedResult"]
    texts, boxes = payload["rec_texts"], payload["rec_boxes"]
    if len(texts) != len(boxes):
        raise ValueError
    cells = [[[] for _ in range(4)] for _ in range(6)]
    for text, box in zip(texts, boxes):
        if not box or not isinstance(text, str):
            continue
        if len(box) < 2 or any(len(point) != 2 for point in box):
            raise ValueError
        if any(not isinstance(n, (int, float)) or isinstance(n, bool)
               or not math.isfinite(n) for point in box for n in point):
            raise ValueError
        x0, x1 = min(p[0] for p in box), max(p[0] for p in box)
        y0, y1 = min(p[1] for p in box), max(p[1] for p in box)
        for row in range(6):
            for col in range(4):
                if (columns[col] <= x0 < x1 <= columns[col + 1]
                        and boundaries[row] <= y0 < y1 <= boundaries[row + 1]):
                    cells[row][col].append((y0, x0, text))
    return [[" ".join(item[2] for item in sorted(cell))
             for cell in row] for row in cells]


def compare(actual: list, spec: dict) -> dict:
    report_rows, total_errors, total_chars, matched, accepted_count = [], 0, 0, 0, 0
    for index, (observed, expected) in enumerate(zip(actual, spec["rows"]), 1):
        fields = {}
        for name, text, reference in zip(spec["fields"], observed, expected):
            raw_reference = reference
            reference, strict_text = normalize(reference), normalize(text)
            errors = distance(reference, strict_text)
            exact = reference == strict_text
            # The sole extra exception removes literal ASCII spaces before the
            # existing normalization. It never deletes Unicode whitespace,
            # changes case, or repairs characters. Keep actual and strict CER.
            accepted = exact or (name == "status" and normalize(
                raw_reference.replace(" ", "")) == normalize(text.replace(" ", "")))
            matched += int(exact)
            accepted_count += int(accepted)
            total_errors += errors
            total_chars += len(reference)
            fields[name] = {"actual": text if "@" not in text else "[redacted]",
                            "exact": exact, "accepted": accepted,
                            "edit_distance": errors,
                            "reference_characters": len(reference),
                            "cer": errors / len(reference)}
        report_rows.append({"row": index, "fields": fields})
    return {"scope": spec["scope"], "normalization": "whitespace-only",
            "comparison_policy": spec["comparison_policy"],
            "matched_fields": matched, "total_fields": 24,
            "character_errors": total_errors, "reference_characters": total_chars,
            "cer": total_errors / total_chars, "strict_passed": matched == 24,
            "accepted_fields": accepted_count, "passed": accepted_count == 24,
            "rows": report_rows}


@contextmanager
def quiet_runtime():
    """Suppress Python and native runtime logs, including unscoped OCR text."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved = [os.dup(1), os.dup(2)]
    try:
        with open(os.devnull, "w") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        for fd, original in zip((1, 2), saved):
            os.dup2(original, fd)
            os.close(original)


def self_test(spec: dict) -> None:
    texts, boxes = [], []
    for row, values in enumerate(spec["rows"]):
        for col, text in enumerate(values):
            x, y = spec["columns"][col] + 5, spec["row_boundaries"][row] + 5
            texts.append(text)
            boxes.append([[x, y], [x + 10, y + 10]])
    texts.extend(["unverified UI", "cross-column"])
    boxes.extend([[[10, 10], [80, 20]], [[330, 470], [350, 480]]])
    response = {"result": {"ocrResults": [{"prunedResult": {
        "rec_texts": texts, "rec_boxes": boxes}}]}}
    actual = assign_cells(response, spec["columns"], spec["row_boundaries"])
    assert compare(actual, spec)["matched_fields"] == 24
    texts[0] = "im-P-001-A"
    actual = assign_cells(response, spec["columns"], spec["row_boundaries"])
    report = compare(actual, spec)
    assert not report["passed"] and report["matched_fields"] == 23
    assert report["character_errors"] == 2
    assert normalize("  입고\n 완료 ") == "입고 완료"
    assert distance("abc", "axc") == 1
    assert distance("abc", "ab") == 1
    assert distance("abc", "abcd") == 1
    assert distance("abc", "") == 3
    # Swapped detections must stay in their geometric cells, not match by text.
    texts[0], texts[4] = texts[4], spec["rows"][0][0]
    actual = assign_cells(response, spec["columns"], spec["row_boundaries"])
    assert compare(actual, spec)["matched_fields"] == 22
    # The approved acceptance exception must never rewrite the raw results or
    # inflate the strict score/CER, and applies only to ASCII status spaces.
    observed = [list(row) for row in spec["rows"]]
    for row in observed:
        row[3] = row[3].replace(" ", "")
    report = compare(observed, spec)
    assert report["matched_fields"] == 18 and report["accepted_fields"] == 24
    assert not report["strict_passed"] and report["passed"]
    assert report["character_errors"] == 6 and report["reference_characters"] == 250
    assert report["cer"] == 0.024
    assert report["rows"][0]["fields"]["status"]["actual"] == "입고완료"
    for column in (0, 1, 2):
        changed = [list(row) for row in observed]
        original = changed[0][column]
        changed[0][column] = original[:1] + " " + original[1:]
        result = compare(changed, spec)
        assert not result["passed"] and result["accepted_fields"] == 23
    changed = [list(row) for row in observed]
    changed[0][3] = "입고완로"
    assert not compare(changed, spec)["passed"]
    changed[0][3] = "입 고\u00a0완료"
    assert not compare(changed, spec)["passed"]
    changed[0][3] = "입 고\t완료"
    assert not compare(changed, spec)["passed"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image")
    parser.add_argument("--expected", required=True)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        spec = json.loads(Path(args.expected).read_text(encoding="utf-8"))
        validate_spec(spec)
        if args.self_test:
            self_test(spec)
            print("Accuracy evaluator self-test passed (no model inference)")
            return 0
        if not args.image:
            raise ValueError
        with quiet_runtime():
            from app.image_validation import validate_base64_image
            from app.ocr_engine import preload_ocr_engine, run_ocr_in_memory
            image = validate_base64_image(base64.b64encode(
                Path(args.image).read_bytes()).decode("ascii"))
            if [image.width, image.height] != spec["image_size"]:
                raise ValueError
            response = run_ocr_in_memory(preload_ocr_engine("korean"), image)
        actual = assign_cells(response, spec["columns"], spec["row_boundaries"])
        report = compare(actual, spec)
    except Exception:
        print("Accuracy check failed safely; details suppressed", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
