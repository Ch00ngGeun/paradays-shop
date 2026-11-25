/** 표 구조화와 정보 유실 방지를 합성 좌표로 검증함. 실제 모델 정확도와 구분함. */
import { describe, expect, it } from "vitest";
import {
  parseOcrTableRows,
  type OcrTableToken,
} from "../infra/lambda/ocr-table-parser.js";
import { parseRecognitionResponse } from "../infra/lambda/paddle-ocr.js";
import baselineProvider from "./fixtures/ocr-baseline-provider.json";
import { token, fixture } from "./ocr-table-parser-fixtures";

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
});
