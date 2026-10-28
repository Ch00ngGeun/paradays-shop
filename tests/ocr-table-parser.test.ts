/** 표 구조화와 정보 유실 방지를 합성 좌표로 검증함. 실제 모델 정확도와 구분함. */
import { describe, expect, it } from "vitest";
import {
  parseOcrTableRows,
  isOcrColumnMapping,
  isOcrRegionMapping,
  isOcrMapping,
  type OcrRegionMapping,
  type OcrColumnMapping,
  type OcrTableToken,
} from "../infra/lambda/ocr-table-parser.js";
import { parseRecognitionResponse } from "../infra/lambda/paddle-ocr.js";
import baselineProvider from "./fixtures/ocr-baseline-provider.json";

function token(id: string, sourceText: string, x: number, y: number, width = 70) {
  return {
    id,
    sourceText,
    confidence: 0.91,
    box: [
      [x, y],
      [x + width, y],
      [x + width, y + 20],
      [x, y + 20],
    ],
  } as const;
}

function fixture() {
  return [
    token("title", "가상 입고표", 20, 10),
    token("h1", "상품명", 20, 80),
    token("h2", "브랜드", 330, 80),
    token("h3", "옵션", 520, 80),
    token("h4", "수량(개)", 800, 80),
    token("p1", "Long test deck", 20, 150, 270),
    token("b1", "Sample Works", 330, 150),
    token("o1", "8.75 inch", 520, 150),
    token("q1", "7", 820, 150, 15),
    token("p2", "Test wheel", 20, 230),
    token("b2", "Other Works", 330, 230),
    token("o2", "52 mm", 520, 230),
    token("q2", "12", 815, 230, 25),
  ];
}

describe("shared JavaScript OCR table parser", () => {
  it("structures the fresh real baseline response into six products and 29 units", () => {
    const recognition = parseRecognitionResponse(baselineProvider);
    expect(recognition.rows).toHaveLength(6);
    expect(recognition.rows.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(
      29,
    );
    expect(recognition.rows.map((row) => row.productName)).toEqual([
      "메이플 데크",
      "스케이트 트럭",
      "스트리트 휠",
      "ABEC-7베어링",
      "블랙 그립테이프",
      "화이트 로고 티셔츠",
    ]);
    expect(recognition.sourceRows).toHaveLength(30);
    expect(recognition.rawText).toContain("입고 상품 목록");
    expect(recognition.rawText).toContain("상품명\n브랜드\n옵션\n수량");
    for (const row of recognition.rows) {
      const source = recognition.sourceRows?.find((token) => token.id === row.id);
      expect(row.confidence).toBe(source?.confidence);
      expect(row.box).toEqual(source?.box);
    }
  });

  it("maps relative header columns and retains exact anchor metadata", () => {
    const rows = fixture();
    const parsed = parseOcrTableRows(rows);
    expect(parsed.mode).toBe("table");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      id: "p1",
      productName: "Long test deck",
      brand: "Sample Works",
      option: "8.75 inch",
      quantity: "7",
      confidence: rows[5].confidence,
      box: rows[5].box,
    });
    expect(parsed.rows[0].sourceText).toContain("Long test deck");
    expect(parsed.rows[0].sourceText).toContain("7");
    expect(rows).toHaveLength(13);
  });

  it("does not depend on OCR array order, absolute positions, or image scale", () => {
    const original = fixture();
    for (const scale of [0.3, 2.6]) {
      const changed = [...original].reverse().map((row) => ({
        ...row,
        box: row.box.map(([x, y]) => [x * scale + 45, y * scale - 15] as const),
      }));
      const parsed = parseOcrTableRows(changed);
      expect(parsed.mode).toBe("table");
      expect(parsed.rows.map((row) => row.sourceText)).toEqual(
        parseOcrTableRows(original).rows.map((row) => row.sourceText),
      );
    }
  });

  it("accepts English headers and arbitrary column order", () => {
    const rows = [
      token("h1", "Qty", 20, 80),
      token("h2", "Item Name", 330, 80),
      token("h3", "Size", 520, 80),
      token("h4", "Brand", 800, 80),
      token("q", "3", 20, 150),
      token("p", "Test bearings", 330, 150),
      token("o", "Pack", 520, 150),
      token("b", "Any Maker", 800, 150),
    ];
    expect(parseOcrTableRows(rows).rows[0]).toMatchObject({
      productName: "Test bearings",
      brand: "Any Maker",
      option: "Pack",
      quantity: "3",
    });
  });

  it.each([
    {
      field: "productName",
      x: 20,
      text: "wrapped name",
      expected: "Long test deck wrapped name",
    },
    { field: "option", x: 520, text: "black", expected: "8.75 inch black" },
  ])("joins an unambiguous wrapped $field cell", ({ field, x, text, expected }) => {
    const rows = fixture();
    rows.push(token("wrapped", text, x, 175));
    const parsed = parseOcrTableRows(rows);
    expect(parsed.mode).toBe("table");
    expect(parsed.rows[0]).toMatchObject({ [field]: expected, quantity: "7" });
    expect(parsed.rows).toHaveLength(2);
  });

  it("orders fragments in one cell from left to right despite slight vertical jitter", () => {
    const rows = fixture().map((row) =>
      row.id === "p1" ? token("p1", "Wrapped", 20, 150) : row,
    );
    rows.push(token("fragment", "deck", 125, 149));
    expect(parseOcrTableRows(rows).rows[0]).toMatchObject({
      productName: "Wrapped deck",
    });
  });

  it("does not join a distinct incomplete product to the previous quantity anchor", () => {
    const rows = [
      ...fixture(),
      token("p-extra", "Another product", 20, 180),
      token("b-extra", "Another maker", 330, 180),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({ mode: "unclassified" });
    expect(parseOcrTableRows(rows).rows).toBe(rows);
  });

  it("does not place a cell near an uncertain column boundary into the wrong field", () => {
    const rows = fixture().map((row) =>
      row.id === "b1" ? token("b1", "Test", 310, 150, 30) : row,
    );
    expect(parseOcrTableRows(rows)).toMatchObject({ mode: "unclassified" });
    expect(parseOcrTableRows(rows).rows).toBe(rows);
  });

  it("retains rows with empty brand, option, or quantity cells", () => {
    for (const missing of ["b1", "o1", "q1"]) {
      const rows = fixture().filter((row) => row.id !== missing);
      const parsed = parseOcrTableRows(rows);
      expect(parsed.mode).toBe("table");
      expect(parsed.rows).toHaveLength(2);
    }
  });

  it.each(["-1", "1.5", "1e2", "2개", "1,000", "1234567890"])(
    "does not invent an integer for invalid quantity %s",
    (quantity) => {
      const rows = fixture().map((row) =>
        row.id === "q1" ? { ...row, sourceText: quantity } : row,
      );
      const parsed = parseOcrTableRows(rows);
      expect(parsed.mode).toBe("table");
      expect(parsed.rows[0]).toMatchObject({ quantity: "" });
      expect(parsed.rows[0].sourceText).toContain(quantity);
    },
  );

  it.each([
    (rows: OcrTableToken[]) => rows.filter((row) => row.id !== "h2"),
    (rows: OcrTableToken[]) =>
      rows.map((row) => (row.id === "h2" ? { ...row, sourceText: "메모" } : row)),
    (rows: OcrTableToken[]) =>
      rows.map((row) => (row.id === "p1" ? { ...row, box: undefined } : row)),
    (rows: OcrTableToken[]) =>
      rows.map((row) =>
        row.id === "p1"
          ? {
              ...row,
              productName: undefined,
              box: [
                [0, 0],
                [0, 0],
              ] as const,
            }
          : row,
      ),
    (rows: OcrTableToken[]) =>
      rows.map((row) =>
        row.id === "p1" ? { ...row, sourceText: "a".repeat(241) } : row,
      ),
    (rows: OcrTableToken[]) => [...rows, token("footer", "unclassified note", 20, 400)],
  ])("returns every original row when structure is uncertain (%#)", (change) => {
    const rows = change(fixture());
    const parsed = parseOcrTableRows(rows);
    expect(parsed.mode).toBe("unclassified");
    expect(parsed.rows).toBe(rows);
  });

  it("handles empty input without generating placeholder rows", () => {
    expect(parseOcrTableRows([])).toEqual({ mode: "empty", reason: "empty", rows: [] });
  });

  it("accepts optional columns and ignores extra image, price and status columns", () => {
    const rows = [
      token("h0", "이미지", 0, 0),
      token("h1", "제품명", 150, 0),
      token("h2", "단가", 450, 0),
      token("h3", "수량", 650, 0),
      token("h4", "상태", 800, 0),
      token("logo", "LOGO", 0, 60),
      token("p", "Synthetic deck", 150, 60),
      token("price", "12,000", 450, 60),
      token("q", "2", 650, 60),
      token("s", "배송완료", 800, 60),
      token("total", "합계", 150, 120),
      token("t", "24,000", 450, 120),
    ];
    expect(parseOcrTableRows(rows)).toMatchObject({
      mode: "table",
      rows: [
        {
          id: "logo",
          productName: "Synthetic deck",
          brand: "",
          option: "",
          quantity: "2",
        },
      ],
    });
  });

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
