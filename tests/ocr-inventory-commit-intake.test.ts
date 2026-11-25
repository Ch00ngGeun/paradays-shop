// 역할: 기존·신규 상품이 섞인 명시적 OCR 입고 계획의 고정·묶기·확인 요구와 중복 차단을 검증함.
import { describe, expect, it, vi } from "vitest";
import { OcrInventoryPlanError } from "@/lib/admin-ui/ocr-inventory-commit";
import {
  buildOcrIntakePlan,
  executeOcrIntakePlan,
  type OcrIntakePlan,
  type OcrIntakeSelection,
} from "@/lib/admin-ui/ocr-inventory-commit-intake";
import type { AdminOcrIntakeInput, AdminOcrIntakeResult } from "@/lib/admin-ui/types";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import {
  product,
  row,
  job,
  newProduct,
  intake,
  intakeResponse,
} from "./ocr-inventory-commit-fixtures";

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
