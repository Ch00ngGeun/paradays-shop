import { describe, expect, it } from "vitest";
import {
  findOcrIntakeMatches,
  getOcrIntakeNewProductValidationMessage,
  normalizeOcrIntakeText,
  ocrIntakeIdentity,
} from "@/lib/admin-ui/ocr-intake-matching";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";

const product: AdminCatalogListItem = {
  id: "prd_deck",
  name: "데크 Example",
  brand: "Maker",
  sizes: "8.25, 8.5",
  sku: "DECK-825",
  category: "Deck",
  price: 80000,
  stock: 10,
  version: 3,
  isVisible: true,
  isFeatured: false,
  description: "",
};
const row = { productName: "데크 Example", brand: "Maker", option: "8.25" };
const draft = {
  name: "New deck",
  brandName: "Maker",
  option: "8.25",
  price: 80000,
  category: "Deck",
};

describe("explicit OCR intake matching", () => {
  it("normalizes NFC, surrounding/repeated whitespace and case, but keeps Korean internal spaces and punctuation", () => {
    expect(normalizeOcrIntakeText("  데크\u00a0  EXAMPLE  ")).toBe("데크 example");
    expect(normalizeOcrIntakeText("스케이트 보드")).not.toBe(
      normalizeOcrIntakeText("스케이트보드"),
    );
    expect(normalizeOcrIntakeText("Deck-8.25")).not.toBe(
      normalizeOcrIntakeText("Deck 8.25"),
    );
    expect(normalizeOcrIntakeText("Ａ")).not.toBe(normalizeOcrIntakeText("A"));
  });
  it("prioritizes an exact product ID over a different SKU and name", () => {
    expect(
      findOcrIntakeMatches(row, [product], { productId: " prd_deck ", sku: "WRONG" }),
    ).toMatchObject({ basis: "product-id", candidates: [product] });
    expect(
      findOcrIntakeMatches(row, [product], { productId: "PRD_DECK" }),
    ).toMatchObject({ basis: "unresolved-id", candidates: [] });
  });
  it("uses NFC/trim but case-sensitive exact SKU without guessing from raw OCR text", () => {
    expect(
      findOcrIntakeMatches({ ...row, productName: "Other" }, [product], {
        sku: " DECK-825 ",
      }).basis,
    ).toBe("sku");
    expect(
      findOcrIntakeMatches({ ...row, productName: "Other" }, [product], {
        sku: "deck-825",
      }).basis,
    ).toBe("none");
  });
  it("compares the exact normalized name, brand and one configured option", () => {
    expect(
      findOcrIntakeMatches(
        { productName: "  데크   EXAMPLE", brand: "MAKER", option: "8.5" },
        [product],
      ),
    ).toMatchObject({ basis: "composite", candidates: [product] });
    expect(
      findOcrIntakeMatches({ ...row, option: "8.50" }, [product]).candidates,
    ).toHaveLength(0);
    expect(
      findOcrIntakeMatches({ ...row, productName: "데크 Examp1e" }, [product])
        .candidates,
    ).toHaveLength(0);
    expect(
      findOcrIntakeMatches({ ...row, brand: "Other" }, [product]).candidates,
    ).toHaveLength(0);
  });
  it.each(["brand", "option"] as const)(
    "missing %s gives possible duplicates, never an automatic selection",
    (field) => {
      const result = findOcrIntakeMatches({ ...row, [field]: "" }, [product]);
      expect(result.basis).toBe("possible");
      expect(result.candidates).toEqual([product]);
      expect(result).not.toHaveProperty("selectedProductId");
    },
  );
  it("keeps all ambiguous candidates and freezes only the result containers", () => {
    const second = { ...product, id: "prd_second" };
    const result = findOcrIntakeMatches(row, [product, second]);
    expect(result.candidates).toEqual([product, second]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(product)).toBe(false);
  });
  it("treats missing catalog options as possible duplicates even when OCR has an option", () => {
    const withoutOptions = { ...product, sizes: " , " };
    expect(findOcrIntakeMatches(row, [withoutOptions])).toMatchObject({
      basis: "possible",
      candidates: [withoutOptions],
    });
  });
  it("checks a known composite even if a supplied new SKU is not present", () => {
    expect(findOcrIntakeMatches(row, [product], { sku: "NEW-SKU" }).basis).toBe(
      "composite",
    );
  });
  it("uses structured identity keys without delimiter collisions", () => {
    expect(ocrIntakeIdentity(draft)).toBe(
      ocrIntakeIdentity({ ...draft, name: " NEW   DECK " }),
    );
    expect(ocrIntakeIdentity({ name: "a|b", brandName: "c", option: "" })).not.toBe(
      ocrIntakeIdentity({ name: "a", brandName: "b|c", option: "" }),
    );
  });
});

describe("new intake product validation", () => {
  it("allows a required zero integer price and explicit optionless DRAFT input", () => {
    expect(
      getOcrIntakeNewProductValidationMessage({ ...draft, price: 0, option: "" }),
    ).toBeNull();
    expect(
      getOcrIntakeNewProductValidationMessage({
        ...draft,
        price: 100_000_000,
        category: "Protection",
      }),
    ).toBeNull();
  });
  it.each([-1, 1.5, NaN, Infinity, 100_000_001])(
    "rejects invalid price %s",
    (price) => {
      expect(getOcrIntakeNewProductValidationMessage({ ...draft, price })).toContain(
        "가격",
      );
    },
  );
  it.each([
    { name: "" },
    { name: "x".repeat(161) },
    { brandName: " " },
    { brandName: "x".repeat(101) },
    { option: "x".repeat(51) },
    { option: "8.25,8.5" },
    { option: "8.25\n" },
    { sku: " " },
    { sku: "x".repeat(81) },
    { category: "unapproved" },
    { name: "x\0" },
  ])("rejects invalid product contract %#", (patch) => {
    expect(
      getOcrIntakeNewProductValidationMessage({ ...draft, ...patch }),
    ).not.toBeNull();
  });
  it("keeps Korean by default and returns English on request", () => {
    expect(getOcrIntakeNewProductValidationMessage({ ...draft, sku: " " })).toBe(
      "신규 SKU는 1~80자로 입력해 주세요.",
    );
    expect(getOcrIntakeNewProductValidationMessage({ ...draft, sku: " " }, "en")).toBe(
      "Enter the new SKU in 1–80 characters.",
    );
    expect(getOcrIntakeNewProductValidationMessage(draft, "en")).toBeNull();
  });
});
