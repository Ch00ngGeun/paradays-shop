import { describe, expect, it } from "vitest";
import {
  normalizeOcrPointer,
  rectsOverlap,
  selectionFromPoints,
  type OcrNormalizedRect,
} from "../lib/admin-ui/ocr-region-selection";

describe("OCR pointer coordinates", () => {
  it("uses the rendered image offset and scale without rounding coordinate data", () => {
    const bounds = { left: 120, top: 240, width: 600, height: 400 };
    const point = normalizeOcrPointer(270, 340, bounds);
    expect(point).toEqual({ x: 0.25, y: 0.25 });
    expect(normalizeOcrPointer(120 + 600 / 3, 240 + 400 / 7, bounds)).toEqual({
      x: 1 / 3,
      y: (240 + 400 / 7 - 240) / 400,
    });
  });

  it("keeps normalized selections identical at different rendered scales", () => {
    for (const scale of [0.2, 1, 2.5]) {
      expect(
        normalizeOcrPointer(75 + 400 * scale, 25 + 150 * scale, {
          left: 75,
          top: 25,
          width: 800 * scale,
          height: 600 * scale,
        }),
      ).toEqual({ x: 0.5, y: 0.25 });
    }
  });

  it("uses client bounds after scrolling without adding document offsets", () => {
    expect(
      normalizeOcrPointer(210, 115, {
        left: 10,
        top: -85,
        width: 400,
        height: 400,
      }),
    ).toEqual({ x: 0.5, y: 0.5 });
  });

  it("clamps pointers released outside the rendered image", () => {
    const bounds = { left: 100, top: 100, width: 400, height: 300 };
    expect(normalizeOcrPointer(-500, 900, bounds)).toEqual({ x: 0, y: 1 });
    expect(normalizeOcrPointer(900, -500, bounds)).toEqual({ x: 1, y: 0 });
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite coordinates or bounds (%s)",
    (value) => {
      const bounds = { left: 1, top: 2, width: 400, height: 300 };
      expect(normalizeOcrPointer(value, 1, bounds)).toBeNull();
      expect(normalizeOcrPointer(1, value, bounds)).toBeNull();
      for (const key of ["left", "top", "width", "height"] as const) {
        expect(normalizeOcrPointer(1, 1, { ...bounds, [key]: value })).toBeNull();
      }
    },
  );

  it.each([0, -1])("rejects zero or negative rendered dimensions (%s)", (value) => {
    expect(
      normalizeOcrPointer(0, 0, { left: 0, top: 0, width: value, height: 1 }),
    ).toBeNull();
    expect(
      normalizeOcrPointer(0, 0, { left: 0, top: 0, width: 1, height: value }),
    ).toBeNull();
  });

  it("rejects numeric overflow during pointer normalization", () => {
    expect(
      normalizeOcrPointer(Number.MAX_VALUE, 0, {
        left: -Number.MAX_VALUE,
        top: 0,
        width: 1,
        height: 1,
      }),
    ).toBeNull();
  });
});

describe("OCR region selection", () => {
  const naturalSize = { width: 1200, height: 800 };

  it("returns the same rectangle for either drag direction", () => {
    const first = { x: 0.1, y: 0.2 };
    const second = { x: 0.8, y: 0.9 };
    const expected = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 };
    expect(selectionFromPoints(first, second, naturalSize)).toEqual(expected);
    expect(selectionFromPoints(second, first, naturalSize)).toEqual(expected);
    expect(first).toEqual({ x: 0.1, y: 0.2 });
    expect(second).toEqual({ x: 0.8, y: 0.9 });
  });

  it("clamps out-of-image endpoints before checking size", () => {
    expect(selectionFromPoints({ x: -4, y: 2 }, { x: 7, y: -1 }, naturalSize)).toEqual({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    });
    expect(
      selectionFromPoints({ x: -4, y: 0.2 }, { x: -1, y: 0.9 }, naturalSize),
    ).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite points or natural image size (%s)",
    (value) => {
      const first = { x: 0.1, y: 0.2 };
      const second = { x: 0.8, y: 0.9 };
      for (const key of ["x", "y"] as const) {
        expect(
          selectionFromPoints({ ...first, [key]: value }, second, naturalSize),
        ).toBeNull();
        expect(
          selectionFromPoints(first, { ...second, [key]: value }, naturalSize),
        ).toBeNull();
      }
      expect(
        selectionFromPoints(first, second, { ...naturalSize, width: value }),
      ).toBeNull();
      expect(
        selectionFromPoints(first, second, { ...naturalSize, height: value }),
      ).toBeNull();
    },
  );

  it.each([0, -1])("rejects zero or negative natural dimensions (%s)", (value) => {
    const first = { x: 0.1, y: 0.2 };
    const second = { x: 0.8, y: 0.9 };
    expect(
      selectionFromPoints(first, second, { width: value, height: 800 }),
    ).toBeNull();
    expect(
      selectionFromPoints(first, second, { width: 1200, height: value }),
    ).toBeNull();
  });

  it("rejects a region below four natural pixels in either dimension", () => {
    expect(
      selectionFromPoints(
        { x: 0, y: 0 },
        { x: 0.039, y: 0.5 },
        { width: 100, height: 100 },
      ),
    ).toBeNull();
    expect(
      selectionFromPoints(
        { x: 0, y: 0 },
        { x: 0.5, y: 0.039 },
        { width: 100, height: 100 },
      ),
    ).toBeNull();
  });

  it("rejects a region below 0.003 normalized units despite enough natural pixels", () => {
    expect(
      selectionFromPoints(
        { x: 0, y: 0 },
        { x: 0.0029, y: 0.5 },
        { width: 4000, height: 4000 },
      ),
    ).toBeNull();
    expect(
      selectionFromPoints(
        { x: 0, y: 0 },
        { x: 0.5, y: 0.0029 },
        { width: 4000, height: 4000 },
      ),
    ).toBeNull();
  });

  it("accepts both exact minimum sizes despite subtraction precision", () => {
    expect(
      selectionFromPoints(
        { x: 0.2, y: 0.2 },
        { x: 0.204, y: 0.204 },
        { width: 1000, height: 1000 },
      ),
    ).toEqual({ left: 0.2, top: 0.2, right: 0.204, bottom: 0.204 });
    expect(
      selectionFromPoints(
        { x: 0.2, y: 0.2 },
        { x: 0.203, y: 0.203 },
        { width: 4000, height: 4000 },
      ),
    ).toEqual({ left: 0.2, top: 0.2, right: 0.203, bottom: 0.203 });
  });

  it("rejects selections with no width or height", () => {
    expect(
      selectionFromPoints({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.8 }, naturalSize),
    ).toBeNull();
    expect(
      selectionFromPoints({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, naturalSize),
    ).toBeNull();
  });
});

describe("OCR region overlap", () => {
  const base: OcrNormalizedRect = { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 };

  it("accepts a positive intersection, including containment", () => {
    const crossing = { left: 0.4, top: 0.5, right: 0.8, bottom: 0.9 };
    const inner = { left: 0.2, top: 0.3, right: 0.4, bottom: 0.5 };
    expect(rectsOverlap(base, crossing)).toBe(true);
    expect(rectsOverlap(crossing, base)).toBe(true);
    expect(rectsOverlap(base, inner)).toBe(true);
    expect(rectsOverlap(base, base)).toBe(true);
  });

  it.each([
    { left: 0.5, top: 0.2, right: 0.8, bottom: 0.6 },
    { left: 0.1, top: 0.6, right: 0.5, bottom: 0.8 },
    { left: 0.5, top: 0.6, right: 0.8, bottom: 0.9 },
    { left: 0.7, top: 0.7, right: 0.8, bottom: 0.8 },
  ])("rejects edge, corner, or disjoint contact (%#)", (other) => {
    expect(rectsOverlap(base, other)).toBe(false);
    expect(rectsOverlap(other, base)).toBe(false);
  });

  it.each([
    { left: NaN, top: 0.2, right: 0.5, bottom: 0.6 },
    { left: 0.1, top: 0.2, right: Infinity, bottom: 0.6 },
    { left: -0.1, top: 0.2, right: 0.5, bottom: 0.6 },
    { left: 0.1, top: 0.2, right: 1.1, bottom: 0.6 },
    { left: 0.5, top: 0.2, right: 0.1, bottom: 0.6 },
    { left: 0.1, top: 0.6, right: 0.5, bottom: 0.2 },
    { left: 0.1, top: 0.2, right: 0.1, bottom: 0.6 },
    { left: 0.1, top: 0.2, right: 0.5, bottom: 0.2 },
  ])("rejects invalid or degenerate normalized rectangles (%#)", (other) => {
    expect(rectsOverlap(base, other)).toBe(false);
    expect(rectsOverlap(other, base)).toBe(false);
  });
});
