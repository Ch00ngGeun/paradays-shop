import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendProductOption,
  createProductSku,
  formatProductDeckOption,
  formatProductWheelOption,
  mergeProductBrandNames,
  PRODUCT_DECK_WIDTHS,
  PRODUCT_OPTION_LIMITS,
  PRODUCT_WHEEL_DIAMETERS,
  PRODUCT_WHEEL_HARDNESSES,
  validateProductOptions,
} from "@/lib/admin-ui/product-form";

afterEach(() => vi.unstubAllGlobals());

describe("product management code", () => {
  it("generates a standard UUID only when explicitly called", () => {
    const id = "5b88cb2d-f6ee-4e9b-90e6-89979581d268";
    const createUuid = vi.fn(() => id);
    expect(createUuid).not.toHaveBeenCalled();
    expect(createProductSku(createUuid)).toBe(id);
    expect(createUuid).toHaveBeenCalledTimes(1);
  });

  it("uses a new independent crypto UUID per requested new draft", () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("5b88cb2d-f6ee-4e9b-90e6-89979581d268")
      .mockReturnValueOnce("18c04cc7-24d9-4e6d-8f93-42462b3bf590");
    vi.stubGlobal("crypto", { randomUUID });
    vi.stubGlobal("window", {
      get location() {
        throw new Error("Must not derive SKU from a session URL");
      },
      get sessionStorage() {
        throw new Error("Must not persist SKU in storage");
      },
      get localStorage() {
        throw new Error("Must not persist SKU in storage");
      },
    });
    const first = createProductSku();
    const second = createProductSku();
    expect(first).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    expect(second).not.toBe(first);
    expect(first.length).toBe(36);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it("does not substitute a timestamp or shortened code when crypto fails", () => {
    expect(() =>
      createProductSku(() => {
        throw new Error("crypto unavailable");
      }),
    ).toThrow("crypto unavailable");
  });
});

describe("product brand choices", () => {
  it("merges current catalog and added names without changing first display spelling", () => {
    const registered = Object.freeze(["NOVA", "April", "한글 브랜드"]);
    const catalog = Object.freeze([
      " nova ",
      "APRIL",
      "River",
      "한글 브랜드",
      "—",
      "",
      " ",
    ]);
    expect(mergeProductBrandNames(registered, catalog)).toEqual([
      "NOVA",
      "April",
      "한글 브랜드",
      "River",
    ]);
    expect(registered).toEqual(["NOVA", "April", "한글 브랜드"]);
    expect(catalog[0]).toBe(" nova ");
  });

  it("keeps punctuation, case-sensitive displayed names and Unicode spellings intact", () => {
    const decomposed = "브랜드";
    expect(
      mergeProductBrandNames(["O'Dwyer", "A & B", decomposed], ["o'dwyer", "브랜드"]),
    ).toEqual(["O'Dwyer", "A & B", decomposed, "브랜드"]);
  });

  it("does not claim choices exist before any names are loaded", () => {
    expect(mergeProductBrandNames([], [])).toEqual([]);
    expect(mergeProductBrandNames()).toEqual([]);
  });
});

describe("existing comma option contract", () => {
  it("retains legacy options byte-for-byte while appending a new choice", () => {
    const legacy = " 8.25”, 8.375” , XL, Custom / Mixed CASE ";
    expect(appendProductOption(legacy, "8.5 inch")).toEqual({
      ok: true,
      value: `${legacy}, 8.5 inch`,
      added: true,
    });
  });

  it("adds a first option and trims only the newly supplied option", () => {
    expect(appendProductOption("", " 8.25 inch ")).toEqual({
      ok: true,
      value: "8.25 inch",
      added: true,
    });
    expect(appendProductOption("  ", "M")).toEqual({
      ok: true,
      value: "  M",
      added: true,
    });
  });

  it("does not add an exact duplicate or normalize other existing variants", () => {
    const legacy = " 8.25”, 8.25 inch, Mixed CASE ";
    expect(appendProductOption(legacy, " 8.25 inch ")).toEqual({
      ok: true,
      value: legacy,
      added: false,
    });
    expect(appendProductOption(legacy, "mixed case")).toEqual({
      ok: true,
      value: `${legacy}, mixed case`,
      added: true,
    });
  });

  it.each(["", " ", "\t"])(
    "rejects an empty new option without clearing existing data: %j",
    (value) => {
      expect(appendProductOption("S, M", value)).toEqual({
        ok: false,
        value: "S, M",
        reason: "empty-option",
      });
    },
  );

  it.each(["M, L", "M\nL", "M\rL"])(
    "does not turn one added choice into several options: %j",
    (value) => {
      expect(appendProductOption("S", value)).toEqual({
        ok: false,
        value: "S",
        reason: "multiple-options",
      });
    },
  );

  it("accepts exactly 50 UTF-16 units and rejects 51 without changing the draft", () => {
    expect(PRODUCT_OPTION_LIMITS.maximumItemLength).toBe(50);
    expect(appendProductOption("", "한".repeat(50)).ok).toBe(true);
    expect(appendProductOption("", "😀".repeat(25)).ok).toBe(true);
    expect(appendProductOption("M", "한".repeat(51))).toEqual({
      ok: false,
      value: "M",
      reason: "option-too-long",
    });
    expect(appendProductOption("M", "😀".repeat(26)).ok).toBe(false);
  });

  it("accepts the twentieth option, refuses the twenty-first, and permits an unchanged duplicate", () => {
    expect(PRODUCT_OPTION_LIMITS.maximumItems).toBe(20);
    const first19 = Array.from({ length: 19 }, (_, index) => `OPTION-${index}`).join(
      ", ",
    );
    const complete = appendProductOption(first19, "LAST");
    expect(complete).toEqual({ ok: true, value: `${first19}, LAST`, added: true });
    expect(appendProductOption(complete.value, "OVERFLOW")).toEqual({
      ok: false,
      value: complete.value,
      reason: "too-many-options",
    });
    expect(appendProductOption(complete.value, "LAST")).toEqual({
      ok: true,
      value: complete.value,
      added: false,
    });
  });

  it("ignores blank comma entries for server-equivalent limits without rewriting them", () => {
    const legacy = " , S, , M, ";
    expect(validateProductOptions(legacy)).toBeNull();
    expect(appendProductOption(legacy, "L")).toEqual({
      ok: true,
      value: `${legacy}, L`,
      added: true,
    });
  });

  it("reports already-invalid legacy data without truncation or automatic repair", () => {
    const tooMany = Array.from({ length: 21 }, (_, index) => `OPTION-${index}`).join(
      ",",
    );
    const tooLong = `M, ${"x".repeat(51)}`;
    expect(validateProductOptions(tooMany)).toBe("too-many-options");
    expect(validateProductOptions(tooLong)).toBe("option-too-long");
    expect(appendProductOption(tooMany, "NEW")).toEqual({
      ok: false,
      value: tooMany,
      reason: "too-many-options",
    });
    expect(appendProductOption(tooLong, "NEW")).toEqual({
      ok: false,
      value: tooLong,
      reason: "option-too-long",
    });
  });
});

describe("new deck and wheel choice formatting", () => {
  it.each(["7.5", "7.75", "8.0", "8.125", "8.25", "8.5"])(
    "formats only an explicitly selected deck width: %s",
    (width) => {
      expect(formatProductDeckOption(width)).toBe(`${width} inch`);
    },
  );

  it.each(["", "direct", "8", "8.00", "8.375”, 8.5”", "8.25 inch", " 8.25", "9.0"])(
    "leaves manual or existing deck options to the raw input: %j",
    (width) => {
      expect(formatProductDeckOption(width)).toBeNull();
    },
  );

  it("lists exactly the requested deck, wheel-size and hardness choices", () => {
    expect(PRODUCT_DECK_WIDTHS).toEqual(["7.5", "7.75", "8.0", "8.125", "8.25", "8.5"]);
    expect(PRODUCT_WHEEL_DIAMETERS).toEqual(
      Array.from({ length: 11 }, (_, index) => 50 + index),
    );
    expect(PRODUCT_WHEEL_HARDNESSES).toEqual(
      Array.from({ length: 22 }, (_, index) => 80 + index),
    );
  });

  it("creates one exact purchasing option for every complete valid wheel combination", () => {
    for (const diameter of PRODUCT_WHEEL_DIAMETERS) {
      for (const hardness of PRODUCT_WHEEL_HARDNESSES) {
        const value = formatProductWheelOption(String(diameter), String(hardness));
        expect(value).toBe(`${diameter}mm / ${hardness}a`);
        expect(appendProductOption("", value!).value.split(",")).toHaveLength(1);
      }
    }
  });

  it.each([
    ["", ""],
    ["54", ""],
    ["", "99"],
    ["49", "99"],
    ["61", "99"],
    ["54", "79"],
    ["54", "102"],
    ["54.5", "99"],
    ["54", "99.5"],
    ["5.4e1", "99"],
    ["54", "9.9e1"],
    ["054", "99"],
    ["54", "099"],
    [" 54", "99"],
    ["54mm", "99"],
    ["54", "99a"],
    ["-54", "99"],
    ["54", "99, 100"],
  ])(
    "does not serialize an incomplete or invalid wheel combination: %j / %j",
    (diameter, hardness) => {
      expect(formatProductWheelOption(diameter, hardness)).toBeNull();
    },
  );
});
