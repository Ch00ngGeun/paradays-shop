import { describe, expect, it, vi } from "vitest";
import {
  buildOcrInventoryPlan,
  buildOcrIntakePlan,
  executeOcrIntakePlan,
  executeOcrInventoryPlan,
  OcrInventoryPlanError,
  type OcrInventoryMode,
  type OcrInventoryPlan,
  type OcrIntakePlan,
  type OcrIntakeSelection,
} from "@/lib/admin-ui/ocr-inventory-commit";
import type {
  AdminCatalogListItem,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  AdminOcrIntakeInput,
  AdminOcrIntakeResult,
} from "@/lib/admin-ui/types";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";

function product(id = "prd_deck", stock = 10): AdminCatalogListItem {
  return {
    id,
    name: "Example deck",
    sku: "DECK-825",
    brand: "Example",
    category: "Deck",
    price: 80_000,
    stock,
    isVisible: true,
    version: 3,
    sizes: "8.25",
    description: "",
    isFeatured: false,
  };
}
function row(id = "row_A", quantity = "2"): AdminOcrReviewRow {
  return {
    id,
    productName: "Reviewed deck",
    quantity,
    sourceText: "PRIVATE RAW TEXT",
    brand: "Example",
    option: "8.25",
  };
}
function job(rows: readonly AdminOcrReviewRow[] = [row()]): AdminOcrRecognitionResult {
  return { jobId: "ocr_saved", version: 2, rawText: "PRIVATE RAW TEXT", rows };
}
function build(mode: OcrInventoryMode = "add", rows = [row()]): OcrInventoryPlan {
  return buildOcrInventoryPlan({
    job: job(rows),
    products: [product()],
    selection: Object.fromEntries(rows.map((item) => [item.id, "prd_deck"])),
    mode,
  });
}
function twoProductPlan(): OcrInventoryPlan {
  return buildOcrInventoryPlan({
    job: job([row("row_A", "2"), row("row_B", "3")]),
    products: [product(), product("prd_wheel", 8)],
    selection: { row_A: "prd_deck", row_B: "prd_wheel" },
    mode: "add",
  });
}

describe("fixed OCR inventory plans", () => {
  it("adds reviewed quantities to selected product stock without guessing names or SKU", () => {
    expect(build()).toEqual({
      jobId: "ocr_saved",
      reviewVersion: 2,
      mode: "add",
      items: [
        {
          productId: "prd_deck",
          productName: "Example deck",
          sku: "DECK-825",
          expectedVersion: 3,
          beforeStock: 10,
          quantity: 2,
          nextStock: 12,
          rowIds: ["row_A"],
        },
      ],
    });
  });
  it("replaces stock with the reviewed total only in explicit replacement mode", () => {
    expect(build("replace").items[0].nextStock).toBe(2);
  });
  it.each([161, 240])(
    "accepts a canonical OCR product name of %s characters with explicit product selection",
    (length) => {
      const plan = build("add", [{ ...row(), productName: "x".repeat(length) }]);
      expect(plan.items[0]).toMatchObject({
        productId: "prd_deck",
        productName: "Example deck",
        nextStock: 12,
      });
    },
  );
  it("rejects an OCR product name above the 240-character review contract", () => {
    expect(() => build("add", [{ ...row(), productName: "x".repeat(241) }])).toThrow(
      OcrInventoryPlanError,
    );
  });
  it("allows grouped zero quantities only in replacement mode", () => {
    const plan = build("replace", [row("row_A", "0"), row("row_B", "0")]);
    expect(plan.items[0]).toMatchObject({
      quantity: 0,
      nextStock: 0,
      rowIds: ["row_A", "row_B"],
    });
    expect(() => build("add", [row("row_A", "0")])).toThrow("1~1,000,000");
    expect(() => build("replace", [row("row_A", "-1")])).toThrow("0~1,000,000");
  });
  it.each(["add", "replace"] as const)(
    "aggregates repeated product selection into one %s write",
    (mode) => {
      const plan = build(mode, [row("row_A", "2"), row("row_B", "3")]);
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0]).toMatchObject({
        quantity: 5,
        nextStock: mode === "add" ? 15 : 5,
        rowIds: ["row_A", "row_B"],
      });
    },
  );
  it.each([
    "",
    "0",
    "-1",
    "1.5",
    " 2",
    "2 ",
    "+2",
    "2e2",
    "1000001",
    "999999999",
    "9007199254740991",
    "1\0",
  ])("rejects an invalid quantity %j", (quantity) => {
    expect(() => build("add", [row("row_A", quantity)])).toThrow(OcrInventoryPlanError);
  });
  it("accepts exact limits and digit-only leading zeros", () => {
    expect(build("replace", [row("row_A", "1000000")]).items[0].nextStock).toBe(
      1_000_000,
    );
    expect(build("replace", [row("row_A", "000002")]).items[0].quantity).toBe(2);
  });
  it("rejects grouped quantity overflow and additive final-stock overflow", () => {
    expect(() =>
      build("replace", [row("row_A", "1000000"), row("row_B", "1")]),
    ).toThrow(OcrInventoryPlanError);
    expect(() => build("add", [row("row_A", "999991")])).toThrow(OcrInventoryPlanError);
  });
  it.each([
    {},
    { row_A: "unknown" },
    { row_A: "Example deck" },
    { row_A: "DECK-825" },
    { row_A: "prd_deck", stale_row: "prd_deck" },
  ])("rejects missing, inferred, unknown, or stale selections (%#)", (selection) => {
    expect(() =>
      buildOcrInventoryPlan({
        job: job(),
        products: [product()],
        selection: selection as Record<string, string>,
        mode: "add",
      }),
    ).toThrow(OcrInventoryPlanError);
  });
  it("does not accept a selected row inherited from the object prototype", () => {
    expect(() =>
      buildOcrInventoryPlan({
        job: job(),
        products: [product()],
        selection: Object.create({ row_A: "prd_deck" }),
        mode: "add",
      }),
    ).toThrow(OcrInventoryPlanError);
  });
  it.each([0, -1, 1.5, 1_000_001, NaN, Infinity])(
    "rejects invalid catalog version %s",
    (version) => {
      expect(() =>
        buildOcrInventoryPlan({
          job: job(),
          products: [{ ...product(), version }],
          selection: { row_A: "prd_deck" },
          mode: "add",
        }),
      ).toThrow(OcrInventoryPlanError);
    },
  );
  it.each([-1, 1.5, 1_000_001, NaN, Infinity])(
    "rejects invalid catalog stock %s",
    (stock) => {
      expect(() =>
        buildOcrInventoryPlan({
          job: job(),
          products: [product("prd_deck", stock)],
          selection: { row_A: "prd_deck" },
          mode: "replace",
        }),
      ).toThrow(OcrInventoryPlanError);
    },
  );
  it("rejects duplicate product IDs even when SKU labels look different", () => {
    expect(() =>
      buildOcrInventoryPlan({
        job: job(),
        products: [product(), { ...product(), sku: "OTHER" }],
        selection: { row_A: "prd_deck" },
        mode: "add",
      }),
    ).toThrow(OcrInventoryPlanError);
  });
  it("rejects an empty review, duplicate row IDs, blank names, and a changed saved row selection", () => {
    expect(() => build("add", [])).toThrow(OcrInventoryPlanError);
    expect(() => build("add", [row(), row()])).toThrow(OcrInventoryPlanError);
    expect(() => build("add", [{ ...row(), productName: "   " }])).toThrow(
      OcrInventoryPlanError,
    );
    expect(() =>
      buildOcrInventoryPlan({
        job: job([row("row_B")]),
        products: [product()],
        selection: { row_A: "prd_deck" },
        mode: "add",
      }),
    ).toThrow(OcrInventoryPlanError);
  });
  it("uses canonical saved quantities and never copies raw text into the plan or validation error", () => {
    const plan = build("add", [row("row_A", "4")]);
    expect(plan.items[0].nextStock).toBe(14);
    expect(JSON.stringify(plan)).not.toContain("PRIVATE RAW TEXT");
    try {
      build("add", [row("row_A", "PRIVATE RAW TEXT")]);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE RAW TEXT");
    }
  });
  it("freezes a copied plan deeply without freezing or retaining mutable input rows", () => {
    const inputRow = row();
    const plan = build("add", [inputRow]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.items)).toBe(true);
    expect(Object.isFrozen(plan.items[0])).toBe(true);
    expect(Object.isFrozen(plan.items[0].rowIds)).toBe(true);
    expect(Object.isFrozen(inputRow)).toBe(false);
  });
});

const newProduct = {
  name: "New deck",
  brandName: "New Maker",
  option: "8.5",
  price: 90000,
  category: "Deck",
};
function intake(
  selection: OcrIntakeSelection = {
    row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
    row_B: { kind: "new", product: newProduct, confirmed: true },
  },
  rows = [row(), row("row_B", "3")],
): OcrIntakePlan {
  return buildOcrIntakePlan({ job: job(rows), products: [product()], selection });
}
function intakeResponse(input: AdminOcrIntakeInput): AdminOcrIntakeResult {
  const beforeStock = input.kind === "existing" ? 10 : 0;
  return {
    product:
      input.kind === "existing"
        ? {
            ...product(input.existing.productId),
            version: input.existing.version + 1,
            stock: beforeStock + input.quantity,
          }
        : {
            ...product("prd_new"),
            name: input.product.name,
            brand: input.product.brandName,
            sku: input.product.sku,
            sizes: input.product.option,
            price: input.product.price,
            category: input.product.category,
            version: 1,
            stock: input.quantity,
            isVisible: false,
            isFeatured: false,
          },
    receipt: {
      operationId: input.operationId,
      kind: input.kind,
      quantity: input.quantity,
      beforeStock,
      afterStock: beforeStock + input.quantity,
      replayed: false,
    },
  };
}

describe("mixed explicit intake plans", () => {
  it("freezes existing additive and unpublished new-product intents without OCR source metadata", () => {
    const plan = intake();
    expect(plan.items).toMatchObject([
      { kind: "existing", beforeStock: 10, quantity: 2, nextStock: 12 },
      { kind: "new", beforeStock: 0, quantity: 3, nextStock: 3, product: newProduct },
    ]);
    expect(Object.isFrozen(plan.items[1])).toBe(true);
    expect(Object.isFrozen(plan.items[1].rowIds)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("PRIVATE");
  });
  it("groups explicitly selected same-product rows into one additive operation", () => {
    const plan = intake({
      row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
      row_B: { kind: "existing", productId: "prd_deck", confirmed: true },
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      quantity: 5,
      nextStock: 15,
      rowIds: ["row_A", "row_B"],
    });
  });
  it("requires individual confirmation and an explicit product selection even with a unique candidate", () => {
    for (const selection of [
      {},
      { row_A: { kind: "existing", productId: "prd_deck", confirmed: false } },
      { row_A: { kind: "existing", productId: "", confirmed: true } },
    ])
      expect(() => intake(selection as OcrIntakeSelection, [row()])).toThrow(
        OcrInventoryPlanError,
      );
  });
  it("does not accept inherited row selections", () => {
    expect(() =>
      intake(
        Object.create({
          row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
        }),
        [row()],
      ),
    ).toThrow(OcrInventoryPlanError);
  });
  it.each(["0", "-2", "1.5", "NaN", "1000001", " 2"])(
    "rejects nonpositive/unbounded intake %j",
    (quantity) => {
      expect(() =>
        intake(
          { row_A: { kind: "existing", productId: "prd_deck", confirmed: true } },
          [row("row_A", quantity)],
        ),
      ).toThrow(OcrInventoryPlanError);
    },
  );
  it("blocks a new product with exact SKU, normalized composite, or missing-option possible duplicate", () => {
    for (const draft of [
      { ...newProduct, sku: "DECK-825" },
      { ...newProduct, name: " EXAMPLE DECK ", brandName: "EXAMPLE", option: "8.25" },
      { ...newProduct, name: "Example deck", brandName: "Example", option: "" },
    ])
      expect(() =>
        intake({ row_A: { kind: "new", product: draft, confirmed: true } }, [row()]),
      ).toThrow("중복 후보");
  });
  it("requires unresolved explicit product IDs to be corrected, without blocking a genuinely new SKU", () => {
    const selection: OcrIntakeSelection = {
      row_A: { kind: "new", product: { ...newProduct, sku: "NEW-1" }, confirmed: true },
    };
    expect(() =>
      buildOcrIntakePlan({
        job: job(),
        products: [product()],
        selection,
        references: { row_A: { productId: "unknown" } },
      }),
    ).toThrow("중복 후보");
    expect(
      buildOcrIntakePlan({ job: job(), products: [product()], selection }).items[0]
        .kind,
    ).toBe("new");
  });
  it("blocks duplicate new identities and duplicate exact SKUs before any writes", () => {
    for (const second of [
      { ...newProduct, name: " NEW DECK " },
      { ...newProduct, name: "Other", sku: "SAME" },
    ])
      expect(() =>
        intake({
          row_A: {
            kind: "new",
            product: { ...newProduct, sku: "SAME" },
            confirmed: true,
          },
          row_B: { kind: "new", product: second, confirmed: true },
        }),
      ).toThrow("여러 행");
  });
  it.each([
    { price: NaN },
    { price: -1 },
    { price: 1.5 },
    { category: "Unknown" },
    { name: "x".repeat(161) },
    { brandName: "" },
    { option: "8.25,8.5" },
  ])("validates every new contract before preview %#", (patch) => {
    expect(() =>
      intake(
        {
          row_A: { kind: "new", product: { ...newProduct, ...patch }, confirmed: true },
        },
        [row()],
      ),
    ).toThrow(OcrInventoryPlanError);
  });
  it("rejects stale extra selections, duplicate rows and additive stock overflow", () => {
    expect(() =>
      intake(
        {
          row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
          stale: { kind: "existing", productId: "prd_deck", confirmed: true },
        },
        [row()],
      ),
    ).toThrow(OcrInventoryPlanError);
    expect(() => intake(undefined, [row(), row()])).toThrow(OcrInventoryPlanError);
    expect(() =>
      intake({ row_A: { kind: "existing", productId: "prd_deck", confirmed: true } }, [
        row("row_A", "1000000"),
      ]),
    ).toThrow(OcrInventoryPlanError);
  });
  it("keeps Korean intake errors by default and returns English on request", async () => {
    const unconfirmed = {
      row_A: { kind: "existing" as const, productId: "prd_deck", confirmed: false },
    };
    expect(() => intake(unconfirmed, [row()])).toThrow(
      "1번째 행의 상품 연결 또는 신규 등록 내용을 개별 확인해 주세요.",
    );
    expect(() =>
      buildOcrIntakePlan(
        { job: job([row()]), products: [product()], selection: unconfirmed },
        "en",
      ),
    ).toThrow("Confirm the product link or new product entry of Row 1 individually.");
    const applyOcrIntake = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await executeOcrIntakePlan(intake(), { applyOcrIntake }, "en");
    expect(result.items[0].message).toBe(
      "The save result is unclear. Check the actual products and stock first. It is not retried automatically to avoid duplicate receipts.",
    );
  });
});

describe("receipt-verified atomic intake execution", () => {
  it("uses stable hashed row identities and sends only an allowlisted intent", async () => {
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) =>
      intakeResponse(input),
    );
    const onProductUpdated = vi.fn();
    const result = await executeOcrIntakePlan(intake(), {
      applyOcrIntake,
      onProductUpdated,
    });
    expect(result.status).toBe("complete");
    expect(result.items.map((item) => item.status)).toEqual(["applied", "applied"]);
    expect(onProductUpdated).toHaveBeenCalledTimes(2);
    expect(applyOcrIntake.mock.calls[0][0]).toEqual({
      operationId: expect.stringMatching(/^ocr_[0-9a-f]{64}$/),
      kind: "existing",
      quantity: 2,
      source: { jobId: "ocr_saved", rowIds: ["row_A"] },
      existing: { productId: "prd_deck", version: 3 },
    });
    expect(applyOcrIntake.mock.calls[1][0]).toMatchObject({
      kind: "new",
      quantity: 3,
      product: newProduct,
    });
    expect(JSON.stringify(applyOcrIntake.mock.calls)).not.toMatch(
      /PRIVATE|sourceText|rawText|reviewVersion|isVisible/,
    );
    const firstId = applyOcrIntake.mock.calls[0][0].operationId;
    await executeOcrIntakePlan({ ...intake(), reviewVersion: 99 }, { applyOcrIntake });
    expect(applyOcrIntake.mock.calls[2][0].operationId).toBe(firstId);
  });
  it("sorts row IDs for stable grouping keys independent of display order", async () => {
    const plan = intake({
      row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
      row_B: { kind: "existing", productId: "prd_deck", confirmed: true },
    });
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) =>
      intakeResponse(input),
    );
    await executeOcrIntakePlan(plan, { applyOcrIntake });
    await executeOcrIntakePlan(
      {
        ...plan,
        items: [{ ...plan.items[0], rowIds: [...plan.items[0].rowIds].reverse() }],
      },
      { applyOcrIntake },
    );
    expect(applyOcrIntake.mock.calls[0][0].operationId).toBe(
      applyOcrIntake.mock.calls[1][0].operationId,
    );
  });
  it("sends the saved job and exact sorted row identities for server per-row claims", async () => {
    const plan = intake(
      {
        row_A: { kind: "existing", productId: "prd_deck", confirmed: true },
        row_B: { kind: "existing", productId: "prd_deck", confirmed: true },
      },
      [row("row_B", "3"), row()],
    );
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) =>
      intakeResponse(input),
    );
    await executeOcrIntakePlan(plan, { applyOcrIntake });
    expect(applyOcrIntake.mock.calls[0][0]).toHaveProperty("source", {
      jobId: "ocr_saved",
      rowIds: ["row_A", "row_B"],
    });
  });
  it("allows at most 96 rows per product group and rejects oversized groups before any write", async () => {
    const rows = Array.from({ length: 96 }, (_, index) => row(`row_${index}`, "1"));
    const selection = Object.fromEntries(
      rows.map((item) => [
        item.id,
        { kind: "existing" as const, productId: "prd_deck", confirmed: true },
      ]),
    );
    const plan = intake(selection, rows);
    expect(plan.items[0].rowIds).toHaveLength(96);
    const tooMany = {
      ...plan,
      items: [
        {
          ...plan.items[0],
          quantity: 97,
          nextStock: 107,
          rowIds: [...plan.items[0].rowIds, "row_extra"],
        },
      ],
    };
    const applyOcrIntake = vi.fn();
    await expect(executeOcrIntakePlan(tooMany, { applyOcrIntake })).rejects.toThrow(
      "최대 96개",
    );
    expect(applyOcrIntake).not.toHaveBeenCalled();
    expect(() =>
      intake(
        {
          ...selection,
          row_extra: { kind: "existing", productId: "prd_deck", confirmed: true },
        },
        [...rows, row("row_extra", "1")],
      ),
    ).toThrow("최대 96개");
  });
  it("canonicalizes NFC names, brands, options and SKU before preview or sending", async () => {
    const plan = intake(
      {
        row_A: {
          kind: "new",
          product: {
            ...newProduct,
            name: " 데크 ",
            brandName: " 브랜드 ",
            option: " 옵션 ",
            sku: " 코드 ",
          },
          confirmed: true,
        },
      },
      [row()],
    );
    expect(plan.items[0]).toMatchObject({
      productName: "데크",
      product: { name: "데크", brandName: "브랜드", option: "옵션", sku: "코드" },
    });
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) =>
      intakeResponse(input),
    );
    expect((await executeOcrIntakePlan(plan, { applyOcrIntake })).status).toBe(
      "complete",
    );
    expect(applyOcrIntake.mock.calls[0][0]).toMatchObject({
      product: { name: "데크", brandName: "브랜드", option: "옵션", sku: "코드" },
    });
  });
  it("skips replay callbacks so an old/deleted product is not resurrected", async () => {
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) => {
      const response = intakeResponse(input);
      return { ...response, receipt: { ...response.receipt, replayed: true } };
    });
    const onProductUpdated = vi.fn();
    const result = await executeOcrIntakePlan(intake(), {
      applyOcrIntake,
      onProductUpdated,
    });
    expect(result.status).toBe("complete");
    expect(result.items.every((item) => item.replayed)).toBe(true);
    expect(onProductUpdated).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409])(
    "stops known rejection %s without retry or later new-product write",
    async (status) => {
      const applyOcrIntake = vi
        .fn()
        .mockRejectedValue(new AdminApiRequestError(status, "SECRET"));
      const result = await executeOcrIntakePlan(intake(), { applyOcrIntake });
      expect(result.items.map((item) => item.status)).toEqual(["failed", "pending"]);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(applyOcrIntake).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new Error("PRIVATE URL TOKEN"),
    new AdminApiRequestError(500, "SECRET"),
    new AdminApiRequestError(429, "SECRET"),
  ])("stops uncertain writes without retry", async (error) => {
    const applyOcrIntake = vi.fn().mockRejectedValue(error);
    const result = await executeOcrIntakePlan(intake(), { applyOcrIntake });
    expect(result.items.map((item) => item.status)).toEqual(["uncertain", "pending"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|TOKEN/);
    expect(applyOcrIntake).toHaveBeenCalledTimes(1);
  });
  it.each([
    "operationId",
    "kind",
    "quantity",
    "beforeStock",
    "afterStock",
    "replayed",
  ] as const)("rejects a mismatched receipt %s", async (field) => {
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) => {
      const response = intakeResponse(input);
      return {
        ...response,
        receipt: { ...response.receipt, [field]: "wrong" },
      } as unknown as AdminOcrIntakeResult;
    });
    const result = await executeOcrIntakePlan(intake(), { applyOcrIntake });
    expect(result.items.map((item) => item.status)).toEqual(["uncertain", "pending"]);
  });
  it("preserves earlier success when a later new response is uncertain", async () => {
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) => {
      const response = intakeResponse(input);
      return input.kind === "new"
        ? { ...response, product: { ...response.product, isVisible: true } }
        : response;
    });
    const result = await executeOcrIntakePlan(intake(), { applyOcrIntake });
    expect(result.items.map((item) => item.status)).toEqual(["applied", "uncertain"]);
  });
  it("takes a deep snapshot before hashing or the first asynchronous write", async () => {
    const original = intake();
    const mutable = {
      ...original,
      items: original.items.map((item) => ({
        ...item,
        rowIds: [...item.rowIds],
        ...(item.kind === "new" ? { product: { ...item.product } } : {}),
      })),
    } as OcrIntakePlan;
    const execution = executeOcrIntakePlan(mutable, {
      applyOcrIntake: async (input) => intakeResponse(input),
    });
    (mutable.items[1] as { quantity: number }).quantity = 999;
    const result = await execution;
    expect(result.status).toBe("complete");
  });
  it("validates every plan item before any write", async () => {
    const plan = intake();
    const applyOcrIntake = vi.fn();
    await expect(
      executeOcrIntakePlan(
        { ...plan, items: [plan.items[0], { ...plan.items[1], nextStock: 100 }] },
        { applyOcrIntake },
      ),
    ).rejects.toBeInstanceOf(OcrInventoryPlanError);
    expect(applyOcrIntake).not.toHaveBeenCalled();
  });
  it("retains an applied item if its UI callback fails and stops later writes", async () => {
    const applyOcrIntake = vi.fn(async (input: AdminOcrIntakeInput) =>
      intakeResponse(input),
    );
    const result = await executeOcrIntakePlan(intake(), {
      applyOcrIntake,
      onProductUpdated: async () => {
        throw new Error("SECRET");
      },
    });
    expect(result.items.map((item) => item.status)).toEqual(["applied", "pending"]);
    expect(applyOcrIntake).toHaveBeenCalledTimes(1);
  });
});

describe("sequential OCR inventory plan execution", () => {
  it("writes a grouped product once with the fixed expected version and verified response", async () => {
    const plan = build("add", [row("row_A", "2"), row("row_B", "3")]);
    const updated = { ...product(), stock: 15, version: 4 };
    const updateProductStock = vi.fn().mockResolvedValue(updated);
    const onProductUpdated = vi.fn();
    const result = await executeOcrInventoryPlan(plan, {
      updateProductStock,
      onProductUpdated,
    });
    expect(updateProductStock).toHaveBeenCalledExactlyOnceWith({
      id: "prd_deck",
      version: 3,
      stock: 15,
    });
    expect(onProductUpdated).toHaveBeenCalledExactlyOnceWith(updated);
    expect(result).toEqual({
      status: "complete",
      items: [{ productId: "prd_deck", status: "applied" }],
    });
  });
  it("skips unchanged replacement stock without requests or an update callback", async () => {
    const updateProductStock = vi.fn();
    const onProductUpdated = vi.fn();
    const result = await executeOcrInventoryPlan(
      build("replace", [row("row_A", "10")]),
      { updateProductStock, onProductUpdated },
    );
    expect(result.items[0].status).toBe("unchanged");
    expect(result.status).toBe("complete");
    expect(updateProductStock).not.toHaveBeenCalled();
    expect(onProductUpdated).not.toHaveBeenCalled();
  });
  it("replaces positive stock with zero using the fixed version and verifies canonical zero", async () => {
    const plan = buildOcrInventoryPlan({
      job: job([row("row_A", "0")]),
      products: [product("prd_deck", 5)],
      selection: { row_A: "prd_deck" },
      mode: "replace",
    });
    const updated = { ...product(), stock: 0, version: 4 };
    const updateProductStock = vi.fn().mockResolvedValue(updated);
    const onProductUpdated = vi.fn();
    const result = await executeOcrInventoryPlan(plan, {
      updateProductStock,
      onProductUpdated,
    });
    expect(updateProductStock).toHaveBeenCalledExactlyOnceWith({
      id: "prd_deck",
      version: 3,
      stock: 0,
    });
    expect(onProductUpdated).toHaveBeenCalledExactlyOnceWith(updated);
    expect(result).toEqual({
      status: "complete",
      items: [{ productId: "prd_deck", status: "applied" }],
    });
  });
  it("skips an unchanged zero-to-zero replacement without requests", async () => {
    const plan = buildOcrInventoryPlan({
      job: job([row("row_A", "0")]),
      products: [product("prd_deck", 0)],
      selection: { row_A: "prd_deck" },
      mode: "replace",
    });
    const updateProductStock = vi.fn();
    const onProductUpdated = vi.fn();
    const result = await executeOcrInventoryPlan(plan, {
      updateProductStock,
      onProductUpdated,
    });
    expect(result).toEqual({
      status: "complete",
      items: [{ productId: "prd_deck", status: "unchanged" }],
    });
    expect(updateProductStock).not.toHaveBeenCalled();
    expect(onProductUpdated).not.toHaveBeenCalled();
  });
  it("rejects a forged zero-quantity add plan during execution before any write", async () => {
    const replacePlan = build("replace", [row("row_A", "0")]);
    const invalid = {
      ...replacePlan,
      mode: "add" as const,
      items: replacePlan.items.map((item) => ({
        ...item,
        nextStock: item.beforeStock,
      })),
    };
    const updateProductStock = vi.fn();
    await expect(
      executeOcrInventoryPlan(invalid, { updateProductStock }),
    ).rejects.toThrow("1~1,000,000");
    expect(updateProductStock).not.toHaveBeenCalled();
  });
  it.each([{ id: "prd_wrong" }, { version: 3 }, { version: 5 }, { stock: 13 }])(
    "stops with uncertain status on canonical response mismatch (%#)",
    async (override) => {
      const updateProductStock = vi
        .fn()
        .mockResolvedValue({ ...product(), stock: 12, version: 4, ...override });
      const onProductUpdated = vi.fn();
      const result = await executeOcrInventoryPlan(twoProductPlan(), {
        updateProductStock,
        onProductUpdated,
      });
      expect(result.status).toBe("stopped");
      expect(result.items.map((item) => item.status)).toEqual(["uncertain", "pending"]);
      expect(updateProductStock).toHaveBeenCalledTimes(1);
      expect(onProductUpdated).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 409])(
    "stops on known API rejection %s without retry or rebasing",
    async (status) => {
      const updateProductStock = vi
        .fn()
        .mockRejectedValue(
          new AdminApiRequestError(status, "SECRET TOKEN endpoint", "PRIVATE RESPONSE"),
        );
      const result = await executeOcrInventoryPlan(twoProductPlan(), {
        updateProductStock,
      });
      expect(result.status).toBe("stopped");
      expect(result.items.map((item) => item.status)).toEqual(["failed", "pending"]);
      expect(updateProductStock).toHaveBeenCalledExactlyOnceWith({
        id: "prd_deck",
        version: 3,
        stock: 12,
      });
      expect(JSON.stringify(result)).not.toMatch(/SECRET TOKEN|PRIVATE RESPONSE/);
    },
  );
  it.each([
    new Error("SECRET TOKEN network"),
    new AdminApiRequestError(503, "PRIVATE endpoint"),
  ])(
    "keeps network or server failures uncertain and stops all later products (%#)",
    async (error) => {
      const updateProductStock = vi.fn().mockRejectedValue(error);
      const result = await executeOcrInventoryPlan(twoProductPlan(), {
        updateProductStock,
      });
      expect(result.items.map((item) => item.status)).toEqual(["uncertain", "pending"]);
      expect(updateProductStock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(/SECRET TOKEN|PRIVATE endpoint/);
    },
  );
  it("preserves successful products when a later request has an unknown result", async () => {
    const updateProductStock = vi
      .fn()
      .mockResolvedValueOnce({ ...product(), stock: 12, version: 4 })
      .mockRejectedValueOnce(new Error("offline"));
    const onProductUpdated = vi.fn();
    const result = await executeOcrInventoryPlan(twoProductPlan(), {
      updateProductStock,
      onProductUpdated,
    });
    expect(result).toMatchObject({
      status: "stopped",
      items: [
        { productId: "prd_deck", status: "applied" },
        { productId: "prd_wheel", status: "uncertain" },
      ],
    });
    expect(updateProductStock.mock.calls).toEqual([
      [{ id: "prd_deck", version: 3, stock: 12 }],
      [{ id: "prd_wheel", version: 3, stock: 11 }],
    ]);
    expect(onProductUpdated).toHaveBeenCalledTimes(1);
  });
  it("validates the entire plan before any request, including a later invalid item", async () => {
    const plan = twoProductPlan();
    const invalid = {
      ...plan,
      items: [plan.items[0], { ...plan.items[1], nextStock: -1 }],
    };
    const updateProductStock = vi.fn();
    await expect(
      executeOcrInventoryPlan(invalid, { updateProductStock }),
    ).rejects.toBeInstanceOf(OcrInventoryPlanError);
    expect(updateProductStock).not.toHaveBeenCalled();
  });
  it("rejects duplicate plan products/rows, invalid mode, and mismatched stock arithmetic before writing", async () => {
    const plan = twoProductPlan();
    const invalidPlans = [
      { ...plan, items: [plan.items[0], plan.items[0]] },
      { ...plan, items: [plan.items[0], { ...plan.items[1], rowIds: ["row_A"] }] },
      { ...plan, mode: "guess" },
      { ...plan, items: [{ ...plan.items[0], nextStock: 100 }] },
    ];
    const updateProductStock = vi.fn();
    for (const invalid of invalidPlans)
      await expect(
        executeOcrInventoryPlan(invalid as OcrInventoryPlan, { updateProductStock }),
      ).rejects.toBeInstanceOf(OcrInventoryPlanError);
    expect(updateProductStock).not.toHaveBeenCalled();
  });
  it("takes an immutable execution snapshot before asynchronous writes begin", async () => {
    const plan = twoProductPlan();
    const mutable = {
      ...plan,
      items: plan.items.map((item) => ({ ...item, rowIds: [...item.rowIds] })),
    };
    const updateProductStock = vi.fn().mockImplementation(async (input) => {
      mutable.items[1].nextStock = 999;
      return { ...product(input.id), stock: input.stock, version: input.version + 1 };
    });
    const result = await executeOcrInventoryPlan(mutable, { updateProductStock });
    expect(result.status).toBe("complete");
    expect(updateProductStock.mock.calls[1][0].stock).toBe(11);
  });
  it("keeps a verified save applied if its UI callback fails, stopping further writes", async () => {
    const updateProductStock = vi
      .fn()
      .mockResolvedValue({ ...product(), stock: 12, version: 4 });
    const onProductUpdated = vi.fn().mockRejectedValue(new Error("SECRET TOKEN UI"));
    const result = await executeOcrInventoryPlan(twoProductPlan(), {
      updateProductStock,
      onProductUpdated,
    });
    expect(result.status).toBe("stopped");
    expect(result.items.map((item) => item.status)).toEqual(["applied", "pending"]);
    expect(updateProductStock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET TOKEN");
  });
});
