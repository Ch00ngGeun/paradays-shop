// 역할: OCR 표 파서의 정규화 드래그 영역 처리와 헤더 없는 행·수량 헤더 선택을 검증함.
import { describe, expect, it } from "vitest";
import {
  parseOcrTableRows,
  isOcrColumnMapping,
  isOcrRegionMapping,
  isOcrMapping,
  type OcrRegionMapping,
} from "../infra/lambda/ocr-table-parser.js";
import { token, fixture } from "./ocr-table-parser-fixtures";

describe("normalized drag regions from canonical tokens", () => {
  const mapping: OcrRegionMapping = {
    schemaVersion: 2,
    parserVersion: 1,
    kind: "regions",
    image: { width: 1000, height: 1000 },
    firstRow: {
      productName: { left: 0.01, top: 0.14, right: 0.31, bottom: 0.175 },
      brand: { left: 0.32, top: 0.14, right: 0.48, bottom: 0.175 },
      option: { left: 0.51, top: 0.14, right: 0.65, bottom: 0.175 },
      quantity: { left: 0.79, top: 0.14, right: 0.87, bottom: 0.175 },
    },
    tableBottom: 0.27,
    secondRowY: null,
    quantityConfirmed: true,
  };
  it("supports headerless rows without dropping the first product and retains canonical metadata", () => {
    const rows = fixture().filter(
      (row) => !row.id.startsWith("h") && row.id !== "title",
    );
    const original = structuredClone(rows);
    const parsed = parseOcrTableRows(rows, mapping);
    expect(parsed).toMatchObject({
      mode: "table",
      rows: [
        {
          id: "p1",
          productName: "Long test deck",
          brand: "Sample Works",
          option: "8.75 inch",
          quantity: "7",
        },
        { id: "p2", productName: "Test wheel", quantity: "12" },
      ],
      region: { sourceTokenCount: 8, includedTokenCount: 8, excludedTokenCount: 0 },
    });
    expect(parsed.rows[0].box).toEqual(rows[0].box);
    expect(parsed.rows[0].confidence).toBe(rows[0].confidence);
    expect(rows).toEqual(original);
  });
  it("scales normalized selections with source image size, shuffled tokens and preserved IDs", () => {
    const original = fixture().filter(
      (row) => !row.id.startsWith("h") && row.id !== "title",
    );
    for (const scale of [0.5, 2]) {
      const rows = [...original].reverse().map((row) => ({
        ...row,
        box: row.box.map(([x, y]) => [x * scale, y * scale] as const),
      }));
      expect(
        parseOcrTableRows(rows, {
          ...mapping,
          image: { width: 1000 * scale, height: 1000 * scale },
        }),
      ).toMatchObject({
        mode: "table",
        rows: [
          { id: "p1", quantity: "7" },
          { id: "p2", quantity: "12" },
        ],
      });
    }
  });
  it("handles absent fields and explicit second-product spacing without guessing quantity", () => {
    const rows = fixture().filter((row) => ["p1", "p2"].includes(row.id));
    const config = {
      ...mapping,
      firstRow: { ...mapping.firstRow, brand: null, option: null, quantity: null },
      quantityConfirmed: false,
      secondRowY: 0.2375,
    };
    expect(parseOcrTableRows(rows, config)).toMatchObject({
      mode: "table",
      rows: [
        { productName: "Long test deck", brand: "", option: "", quantity: "" },
        { productName: "Test wheel", quantity: "" },
      ],
    });
    expect(parseOcrTableRows(rows, { ...config, secondRowY: null })).toMatchObject({
      mode: "unclassified",
      reason: "region-second-row-required",
      rows,
    });
  });
  it("preserves excluded noise and rejects footer, known-price quantity and uncertain row spacing", () => {
    const rows = fixture();
    expect(parseOcrTableRows(rows, mapping)).toMatchObject({
      mode: "table",
      region: { sourceTokenCount: 13, includedTokenCount: 8, excludedTokenCount: 5 },
    });
    expect(
      parseOcrTableRows(
        rows.map((row) => (row.id === "h4" ? { ...row, sourceText: "금액" } : row)),
        mapping,
      ),
    ).toMatchObject({ mode: "unclassified", reason: "quantity-column-conflict" });
    expect(
      parseOcrTableRows(
        rows.map((row) => (row.id === "p2" ? { ...row, sourceText: "합계" } : row)),
        mapping,
      ),
    ).toMatchObject({ mode: "unclassified", reason: "region-footer-uncertain" });
    expect(parseOcrTableRows(rows, { ...mapping, secondRowY: 0.265 })).toMatchObject({
      mode: "unclassified",
      reason: "region-row-spacing-uncertain",
    });
  });
  it.each(["12,000", "1.5", "2개", "배송완료"])(
    "does not turn %s into a quantity",
    (value) => {
      const rows = fixture().map((row) =>
        row.id === "q1" ? { ...row, sourceText: value } : row,
      );
      expect(parseOcrTableRows(rows, mapping)).toMatchObject({
        mode: "unclassified",
        reason: "region-quantity-invalid",
        rows,
      });
    },
  );
  it.each(["KRW", "(원)", "VAT 포함"])(
    "does not let the notice %s hide an aligned price header",
    (notice) => {
      const rows = fixture().map((row) =>
        row.id === "h4"
          ? { ...row, sourceText: "금액" }
          : row.id === "q1"
            ? { ...row, sourceText: "12000" }
            : row.id === "q2"
              ? { ...row, sourceText: "24000" }
              : row,
      );
      for (const variant of [
        rows,
        [...rows, token("currency", notice, 800, 110, 60)],
      ]) {
        expect(parseOcrTableRows(variant, mapping)).toMatchObject({
          mode: "unclassified",
          reason: "quantity-column-conflict",
          rows: variant,
        });
      }
    },
  );
  it("uses the nearer actual quantity header instead of an older price header or intervening notice", () => {
    const rows = [
      ...fixture().map((row) =>
        row.id === "h4" ? { ...row, sourceText: "금액" } : row,
      ),
      token("actual-qty", "Quantity", 800, 100, 70),
      token("qty-unit", "pcs", 800, 115, 60),
    ];
    expect(parseOcrTableRows(rows, mapping)).toMatchObject({
      mode: "table",
      rows: [{ quantity: "7" }, { quantity: "12" }],
    });
  });
  it("accepts repeated quantity header aliases without treating them as conflicting roles", () => {
    const rows = [
      ...fixture(),
      token("qty-alias", "Qty", 800, 105, 60),
      token("qty-unit", "pcs", 800, 115, 60),
    ];
    expect(parseOcrTableRows(rows, mapping)).toMatchObject({
      mode: "table",
      rows: [{ quantity: "7" }, { quantity: "12" }],
    });
  });
  it("does not let an older quantity header override a nearer price header", () => {
    const rows = [
      ...fixture(),
      token("actual-price", "가격", 800, 105, 60),
      token("currency", "KRW", 800, 115, 60),
    ];
    expect(parseOcrTableRows(rows, mapping)).toMatchObject({
      mode: "unclassified",
      reason: "quantity-column-conflict",
      rows,
    });
  });
  it("rejects competing price and quantity evidence on one header line regardless of provider order", () => {
    const rows = [
      ...fixture(),
      token("competing-price", "금액", 800, 80, 60),
      token("currency", "KRW", 800, 110, 60),
    ];
    for (const variant of [rows, [...rows].reverse()])
      expect(parseOcrTableRows(variant, mapping)).toMatchObject({
        mode: "unclassified",
        reason: "quantity-column-conflict",
        rows: variant,
      });
  });
  it("rejects overlapping price and quantity headers with equal bottom edges and different heights in either token order", () => {
    const price = {
      ...token("tall-price", "금액", 800, 40, 60),
      box: [
        [800, 40],
        [860, 40],
        [860, 100],
        [800, 100],
      ] as const,
    };
    const rows = [...fixture(), price, token("currency", "KRW", 800, 110, 60)];
    for (const variant of [rows, [...rows].reverse()])
      expect(parseOcrTableRows(variant, mapping)).toMatchObject({
        mode: "unclassified",
        reason: "quantity-column-conflict",
        rows: variant,
      });
  });
  it("requires bounded nonoverlapping rectangles, actual quantity confirmation and exact config keys", () => {
    expect(isOcrRegionMapping(mapping)).toBe(true);
    expect(isOcrMapping(mapping)).toBe(true);
    for (const invalid of [
      { ...mapping, quantityConfirmed: false },
      { ...mapping, parserVersion: 2 },
      { ...mapping, image: { width: 100000, height: 1000 } },
      {
        ...mapping,
        firstRow: { ...mapping.firstRow, brand: mapping.firstRow.productName },
      },
      {
        ...mapping,
        firstRow: {
          ...mapping.firstRow,
          productName: { left: 0, top: 0.14, right: 0.001, bottom: 0.16 },
        },
      },
      { ...mapping, rawText: "private" },
      { ...mapping, tableBottom: 0.1 },
      { ...mapping, secondRowY: 0.16 },
    ])
      expect(isOcrRegionMapping(invalid)).toBe(false);
    expect(isOcrColumnMapping(mapping)).toBe(false);
  });
  it("does not silently drop wrapped or partially overlapping later product fragments", () => {
    for (const extra of [
      token("top-edge", "crossing top", 20, 128, 100),
      token("wrap", "wrapped continuation", 20, 255),
      token("edge", "edge fragment", 290, 230, 100),
    ]) {
      const rows = [...fixture(), extra];
      expect(parseOcrTableRows(rows, mapping)).toMatchObject({
        mode: "unclassified",
        reason: "region-boundary-uncertain",
        rows,
      });
    }
  });
  it("uses canonical quantity anchors with variable spacing even when a second-row hint exists", () => {
    const rows = [
      ...fixture(),
      token("p3", "Third deck", 20, 350),
      token("b3", "Maker", 330, 350),
      token("o3", "Black", 520, 350),
      token("q3", "4", 815, 350, 25),
    ];
    const parsed = parseOcrTableRows(rows, {
      ...mapping,
      tableBottom: 0.39,
      secondRowY: 0.2375,
    });
    expect(parsed).toMatchObject({
      mode: "table",
      rows: [{ quantity: "7" }, { quantity: "12" }, { quantity: "4" }],
    });
  });
  it("accepts the same exact four-pixel selections as the browser helper", () => {
    const minimal = {
      ...mapping,
      firstRow: {
        productName: { left: 0.2, top: 0.2, right: 0.204, bottom: 0.204 },
        brand: null,
        option: null,
        quantity: null,
      },
      tableBottom: 0.21,
      quantityConfirmed: false,
    };
    expect(isOcrRegionMapping(minimal)).toBe(true);
  });
});
