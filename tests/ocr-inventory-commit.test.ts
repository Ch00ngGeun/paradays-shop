import { describe, expect, it, vi } from "vitest";
import {
  buildOcrInventoryPlan,
  executeOcrInventoryPlan,
  OcrInventoryPlanError,
  type OcrInventoryPlan,
} from "@/lib/admin-ui/ocr-inventory-commit";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import {
  product,
  row,
  job,
  build,
  twoProductPlan,
} from "./ocr-inventory-commit-fixtures";

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
