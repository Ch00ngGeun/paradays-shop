/** 역할: PaddleOCR provider 응답에서 인식 결과 node·신뢰도·bounding box를 안전하게 찾아 읽는 도우미임. */
import { isRecord } from "./request-helpers.js";
import { type OcrBoundingBox } from "./paddle-ocr.js";

/** nested result/data/results/prunedResult를 깊이 제한으로 탐색해 예상과 다른 provider envelope도 안전하게 처리합니다. */
export function findRecognitionNode(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 8) {
    return undefined;
  }

  // isRecord는 JSON array도 object로 간주하므로 반드시 먼저 처리합니다. 특히 canonical
  // result.ocrResults[0].prunedResult envelope는 이 배열 traversal 없이는 도달할 수 없습니다.
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = findRecognitionNode(item, depth + 1);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (isRecord(value)) {
    if (Array.isArray(value.rec_texts)) {
      return value;
    }

    for (const key of [
      "prunedResult",
      "result",
      "results",
      "data",
      "output",
      "ocr_result",
      "ocrResult",
      "ocrResults",
    ]) {
      const found = findRecognitionNode(value[key], depth + 1);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  return undefined;
}

export function readConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

export function readBoundingBox(value: unknown): OcrBoundingBox | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  // PaddleOCR의 native rec_boxes는 [left, top, right, bottom]일 수 있습니다.
  // Internal/public OCR rows는 point polygon만 허용하므로 여기서 직사각형으로 정규화합니다.
  const [left, top, right, bottom] = value;

  if (
    value.length === 4 &&
    isBoundingCoordinate(left) &&
    isBoundingCoordinate(top) &&
    isBoundingCoordinate(right) &&
    isBoundingCoordinate(bottom)
  ) {
    return [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
  }

  if (value.length < 2 || value.length > 8) {
    return undefined;
  }

  const points: [number, number][] = [];

  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !isBoundingCoordinate(point[0]) ||
      !isBoundingCoordinate(point[1])
    ) {
      return undefined;
    }

    points.push([point[0], point[1]]);
  }

  return points;
}

function isBoundingCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
  );
}
