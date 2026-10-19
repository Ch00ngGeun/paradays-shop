/** 렌더링 크기와 무관하게 서버에 전달할 0~1 범위의 좌표임. */
export type OcrNormalizedPoint = Readonly<{ x: number; y: number }>;

export type OcrNormalizedRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

/** 실제 이미지 getBoundingClientRect 결과이며 스크롤 위치가 이미 반영됨. */
export type OcrRenderedImageBounds = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type OcrNaturalImageSize = Readonly<{ width: number; height: number }>;

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const finite = (values: readonly number[]): boolean => values.every(Number.isFinite);
const normalized = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

/** 마우스·터치 PointerEvent의 client 좌표를 실제 이미지 기준으로 정규화함. */
export function normalizeOcrPointer(
  clientX: number,
  clientY: number,
  bounds: OcrRenderedImageBounds,
): OcrNormalizedPoint | null {
  if (
    !finite([clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height]) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return null;
  const x = (clientX - bounds.left) / bounds.width;
  const y = (clientY - bounds.top) / bounds.height;
  if (!finite([x, y])) return null;
  return { x: clamp(x), y: clamp(y) };
}

/** 역방향 드래그도 같은 영역으로 만들며 작거나 퇴화한 선택은 거부함. */
export function selectionFromPoints(
  start: OcrNormalizedPoint,
  end: OcrNormalizedPoint,
  naturalSize: OcrNaturalImageSize,
): OcrNormalizedRect | null {
  if (
    !finite([start.x, start.y, end.x, end.y, naturalSize.width, naturalSize.height]) ||
    naturalSize.width <= 0 ||
    naturalSize.height <= 0
  )
    return null;
  const left = Math.min(clamp(start.x), clamp(end.x));
  const right = Math.max(clamp(start.x), clamp(end.x));
  const top = Math.min(clamp(start.y), clamp(end.y));
  const bottom = Math.max(clamp(start.y), clamp(end.y));
  const width = right - left;
  const height = bottom - top;
  // 정확히 경계인 선택이 뺄셈 오차로 거부되지 않게 비교에만 미세 오차를 허용함.
  const tolerance = Number.EPSILON * 8;
  if (
    width <= 0 ||
    height <= 0 ||
    width + tolerance < Math.max(0.003, 4 / naturalSize.width) ||
    height + tolerance < Math.max(0.003, 4 / naturalSize.height)
  )
    return null;
  return { left, top, right, bottom };
}

function validRect(rect: OcrNormalizedRect): boolean {
  return (
    [rect.left, rect.top, rect.right, rect.bottom].every(normalized) &&
    rect.left < rect.right &&
    rect.top < rect.bottom
  );
}

/** 가장자리 접촉은 겹침이 아니며 양쪽 영역에 양수 교집합이 있을 때만 참임. */
export function rectsOverlap(a: OcrNormalizedRect, b: OcrNormalizedRect): boolean {
  return (
    validRect(a) &&
    validRect(b) &&
    Math.max(a.left, b.left) < Math.min(a.right, b.right) &&
    Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom)
  );
}
