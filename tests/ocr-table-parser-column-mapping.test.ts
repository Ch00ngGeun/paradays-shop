// 역할: 공유 OCR 표 파서의 명시적 열 매핑·복합 셀·헤더 인식과 매핑 설정 검증을 확인함.
import { describe, expect, it } from "vitest";
import {
  parseOcrTableRows,
  isOcrColumnMapping,
  type OcrColumnMapping,
} from "../infra/lambda/ocr-table-parser.js";
import { token, fixture } from "./ocr-table-parser-fixtures";

describe("shared JavaScript OCR table parser", () => {
  it("supports explicit user columns without altering canonical tokens or metadata", () => {
    const rows = fixture().map((row) =>
      row.id === "h2" ? { ...row, sourceText: "공급처" } : row,
    );
    const before = structuredClone(rows);
    const mapping: OcrColumnMapping = {
      schemaVersion: 1,
      headerRow: 1,
      columns: { productName: 0, brand: 1, option: 2, quantity: 3 },
    };
    expect(parseOcrTableRows(rows).mode).toBe("unclassified");
    const parsed = parseOcrTableRows(rows, mapping);
    expect(parsed).toMatchObject({
      mode: "table",
      rows: [
        { id: "p1", brand: "Sample Works" },
        { id: "p2", brand: "Other Works" },
      ],
    });
    const swapped = parseOcrTableRows(rows, {
      ...mapping,
      columns: { ...mapping.columns, productName: 1, brand: 0 },
    });
    expect(swapped.rows.map((row) => row.id)).toEqual(parsed.rows.map((row) => row.id));
    expect(swapped.rows[0].box).toEqual(rows[5].box);
    expect(rows).toEqual(before);
  });

  it("parses labelled composite cells while retaining all excluded originals", () => {
    const rows = [
      token("h1", "상품정보", 20, 0),
      token("h2", "수량", 450, 0),
      token("h3", "금액", 650, 0),
      token("p", "상품명: Wrapped", 20, 60),
      token("q", "2", 450, 85),
      token("price", "12000", 650, 85),
      token("wrap", "deck", 20, 85),
      token("b", "브랜드: Any maker", 20, 110),
      token("o", "옵션: Black", 20, 135),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "table",
      rows: [
        {
          id: "p",
          productName: "Wrapped deck",
          brand: "Any maker",
          option: "Black",
          quantity: "2",
        },
      ],
    });
    expect(rows).toHaveLength(9);
  });

  it("does not guess unlabelled composite brand and allows explicit line selectors", () => {
    const rows = [
      token("h1", "상품정보", 20, 0),
      token("h2", "수량", 450, 0),
      token("b", "Any maker", 20, 60),
      token("p", "Test deck", 20, 85),
      token("q", "2", 450, 85),
      token("o", "Black", 20, 110),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "unclassified",
      reason: "ambiguous-product-info",
    });
    expect(
      parseOcrTableRows(rows, {
        schemaVersion: 1,
        headerRow: 0,
        columns: { productName: 0, brand: null, option: null, quantity: 1 },
        productInfo: { productNameLine: 1, brandLine: 0, optionLine: 2 },
      }),
    ).toMatchObject({
      mode: "table",
      rows: [
        {
          productName: "Test deck",
          brand: "Any maker",
          option: "Black",
          quantity: "2",
        },
      ],
    });
  });

  it("rejects price/status-to-quantity mappings even when numbers look valid", () => {
    const rows = [
      token("h1", "상품명", 20, 0),
      token("h2", "단가", 450, 0),
      token("p", "Test", 20, 60),
      token("price", "12000", 450, 60),
    ];
    expect(
      parseOcrTableRows(rows, {
        schemaVersion: 1,
        headerRow: 0,
        columns: { productName: 0, brand: null, option: null, quantity: 1 },
      }),
    ).toMatchObject({ mode: "unclassified", reason: "quantity-column-conflict" });
  });

  it("recognizes fragmented header words", () => {
    const rows = [
      token("h1a", "Product", 20, 0, 70),
      token("h1b", "Name", 100, 0),
      token("h2", "Qty", 450, 0),
      token("p", "Test", 20, 60),
      token("q", "3", 450, 60),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "table",
      rows: [{ productName: "Test", quantity: "3" }],
    });
  });

  it("validates mapping configuration strictly without accepting source or secret fields", () => {
    const mapping = {
      schemaVersion: 1,
      headerRow: 0,
      columns: { productName: 0, brand: null, option: null, quantity: 1 },
    };
    expect(isOcrColumnMapping(mapping)).toBe(true);
    for (const value of [
      null,
      [],
      { ...mapping, rawText: "secret" },
      { ...mapping, headerRow: 500 },
      { ...mapping, columns: { ...mapping.columns, quantity: 0 } },
      { ...mapping, columns: { ...mapping.columns, quantity: -1 } },
      {
        ...mapping,
        productInfo: { productNameLine: 0, brandLine: 0, optionLine: null },
      },
    ])
      expect(isOcrColumnMapping(value)).toBe(false);
  });
  it("rejects hidden attributes, getters, and custom serializers in numeric settings", () => {
    const mapping = {
      schemaVersion: 1,
      headerRow: 0,
      columns: { productName: 0, brand: null, option: null, quantity: 1 },
    };
    let read = false;
    const withGetter = { ...mapping };
    Object.defineProperty(withGetter, "columns", {
      get() {
        read = true;
        return mapping.columns;
      },
    });
    expect(isOcrColumnMapping(withGetter)).toBe(false);
    expect(read).toBe(false);
    expect(
      isOcrColumnMapping(
        Object.defineProperty({ ...mapping }, "secret", {
          value: "private",
          enumerable: false,
        }),
      ),
    ).toBe(false);
    expect(isOcrColumnMapping({ ...mapping, [Symbol("rawText")]: "private" })).toBe(
      false,
    );
    expect(
      isOcrColumnMapping(
        Object.assign(
          Object.create({ toJSON: () => ({ rawText: "private" }) }),
          mapping,
        ),
      ),
    ).toBe(false);
  });

  it("does not truncate products named Total or status-like content in other cells", () => {
    const rows = [
      token("h1", "상품명", 20, 0),
      token("h2", "수량", 450, 0),
      token("p1", "First", 20, 60),
      token("q1", "1", 450, 60),
      token("p2", "Total", 20, 140),
      token("q2", "2", 450, 140),
      token("p3", "Last", 20, 220),
      token("q3", "3", 450, 220),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "table",
      rows: [
        { productName: "First" },
        { productName: "Total" },
        { productName: "Last" },
      ],
    });
  });
  it.each(["배송완료", "로그인", "마이페이지"])(
    "does not append standalone noise %s to a product",
    (text) => {
      const rows = [
        token("h1", "상품명", 20, 0),
        token("h2", "수량", 450, 0),
        token("p", "First", 20, 60),
        token("q", "1", 450, 60),
        token("noise", text, 20, 90),
      ];
      expect(parseOcrTableRows(rows)).toMatchObject({
        mode: "unclassified",
        reason: "ambiguous-noise",
      });
    },
  );
  it.each(["가격: 12000", "상태: 배송완료", "브랜드: Maker 옵션: Red"])(
    "does not hide composite uncertainty in a product field: %s",
    (text) => {
      const rows = [
        token("h1", "상품정보", 20, 0),
        token("h2", "수량", 450, 0),
        token("p", "상품명: Demo", 20, 60),
        token("q", "1", 450, 60),
        token("noise", text, 20, 85),
      ];
      expect(parseOcrTableRows(rows)).toMatchObject({
        mode: "unclassified",
        reason: "ambiguous-product-info",
      });
    },
  );
  it("does not report header-only input as a classified product table", () => {
    const rows = [token("h1", "상품명", 20, 0), token("h2", "수량", 450, 0)];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "unclassified",
      reason: "no-product-rows",
    });
  });
  it("omits out-of-contract descriptors while retaining oversized table originals", () => {
    const rows = [
      token("h0", "상품명", 0, 0),
      ...Array.from({ length: 20 }, (_, i) =>
        token(`h${i + 1}`, `N${i + 1}`, (i + 1) * 150, 0),
      ),
    ];
    const parsed = parseOcrTableRows(rows);
    expect(parsed).toMatchObject({ mode: "unclassified", rows });
    expect(parsed).not.toHaveProperty("table");
  });
  it("does not treat the first product as a manual header and silently lose it", () => {
    const rows = [
      token("p1", "First deck", 20, 0),
      token("q1", "2", 450, 0),
      token("p2", "Second deck", 20, 80),
      token("q2", "3", 450, 80),
    ];
    expect(
      parseOcrTableRows(rows, {
        schemaVersion: 1,
        headerRow: 0,
        columns: { productName: 0, brand: null, option: null, quantity: 1 },
      }),
    ).toMatchObject({ mode: "unclassified", reason: "header-not-confirmed", rows });
  });
  it("groups four synthetic composite order rows without image/status/price in product fields", () => {
    const rows = [
      token("h0", "이미지", 0, 0),
      token("h1", "상품정보", 150, 0),
      token("h2", "단가", 500, 0),
      token("h3", "수량", 700, 0),
      token("h4", "금액", 850, 0),
      token("h5", "배송상태", 1050, 0),
    ];
    const amounts = [120000, 180000, 102000, 100000];
    for (let i = 0; i < 4; i++) {
      const y = 80 + i * 150;
      rows.push(
        token(`name${i}`, `상품명: Synthetic item ${i + 1}`, 150, y),
        token(`brand${i}`, `브랜드: Test maker ${i + 1}`, 150, y + 25),
        token(`option${i}`, `옵션: Variant ${i + 1}`, 150, y + 50),
        token(`image${i}`, "LOGO", 0, y + 25),
        token(`price${i}`, String(amounts[i]), 500, y + 25),
        token(`qty${i}`, i === 0 ? "2" : "1", 700, y + 25),
        token(`amount${i}`, String(amounts[i]), 850, y + 25),
        token(`status${i}`, "배송완료", 1050, y + 25),
      );
    }
    rows.push(
      token("total", "합계", 150, 700),
      token("totalAmount", "502000", 850, 700),
    );
    const original = structuredClone(rows);
    for (const scale of [0.5, 1, 2]) {
      const transformed = [...rows].reverse().map((row) => ({
        ...row,
        box: row.box.map(([x, y]) => [x * scale + 15, y * scale + 30] as const),
      }));
      const parsed = parseOcrTableRows(transformed);
      expect(parsed.mode).toBe("table");
      expect(parsed.rows).toHaveLength(4);
      expect(
        parsed.rows.reduce(
          (sum, row) => sum + Number("quantity" in row ? row.quantity : 0),
          0,
        ),
      ).toBe(5);
      expect(
        parsed.rows.every(
          (row) =>
            "productName" in row &&
            !/LOGO|배송완료|502000/u.test(String(row.productName)),
        ),
      ).toBe(true);
    }
    expect(amounts.reduce((sum, n) => sum + n, 0)).toBe(502000);
    expect(rows).toEqual(original);
  });
});
