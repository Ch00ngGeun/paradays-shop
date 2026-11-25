// 역할: 관리자 API 클라이언트의 OCR 카탈로그 입고 명령 전송·인증·정규화·스냅숏 처리를 검증함.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApiClient } from "@/lib/commerce/admin-api-client";
import { AdminApiResponseError } from "@/lib/commerce/admin-api-client-errors";
import type { AdminOcrIntakeInput } from "@/lib/admin-ui/types";
import { apiConfig, createClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("atomic OCR catalog intake", () => {
  const existing: AdminOcrIntakeInput = {
    operationId: "ocr-intake-1",
    kind: "existing",
    quantity: 3,
    source: { jobId: "ocr-job-intake", rowIds: ["ocr_1"] },
    existing: { productId: "product-1", version: 2 },
  };
  const fresh: AdminOcrIntakeInput = {
    operationId: "ocr-intake-new",
    kind: "new",
    quantity: 3,
    source: { jobId: "ocr-job-intake", rowIds: ["ocr_2"] },
    product: {
      name: "New Bearings",
      brandName: "Synthetic",
      option: "Set 8",
      price: 12000,
      category: "Bearings",
    },
  };
  function result(input: AdminOcrIntakeInput = existing, replayed = false) {
    return {
      product: {
        productId: "product-1",
        name: input.kind === "new" ? input.product.name : "Existing Bearings",
        brandName: "Synthetic",
        category: "Bearings",
        price: 12000,
        inventoryQuantity: input.kind === "new" ? 3 : 10,
        status: "DRAFT",
        featured: false,
        sizes: ["Set 8"],
        description: [],
        version: input.kind === "new" ? 1 : 3,
      },
      receipt: {
        operationId: input.operationId,
        kind: input.kind,
        quantity: 3,
        beforeStock: input.kind === "new" ? 0 : 7,
        afterStock: input.kind === "new" ? 3 : 10,
        replayed,
      },
    };
  }

  it.each([false, true])(
    "sends one authenticated production command and validates an original/replayed receipt %s",
    async (replayed) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_ENABLED", "true");
      vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_API_URL", "https://ocr-relay.demo.test");
      vi.stubEnv(
        "NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN",
        "https://ocr-relay.demo.test",
      );
      vi.stubGlobal("window", { location: { origin: "https://paradays.web.app" } });
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(result(existing, replayed)));
      const { client, getAccessToken } = createClient(fetchImplementation);
      expect((await client.applyOcrIntake(existing)).receipt).toMatchObject({
        replayed,
        beforeStock: 7,
        afterStock: 10,
      });
      expect(getAccessToken).toHaveBeenCalledOnce();
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(fetchImplementation.mock.calls[0][0]).toBe(
        "https://api.example.com/prod/admin/catalog/products",
      );
      const init = fetchImplementation.mock.calls[0][1];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "ocr-intake",
        ...existing,
      });
      expect(String(init?.body)).not.toMatch(
        /sourceText|rawText|confidence|box|imageBase64/u,
      );
    },
  );

  it("registers only a confirmed DRAFT product with price/category and initial intake stock", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(result(fresh)));
    const { client } = createClient(fetchImplementation);
    expect((await client.applyOcrIntake(fresh)).product).toMatchObject({
      stock: 3,
      price: 12000,
      category: "Bearings",
      isVisible: false,
      version: 1,
    });
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
      action: "ocr-intake",
      ...fresh,
    });
  });

  it("accepts an explicitly entered zero price under the existing product contract", async () => {
    const input = { ...fresh, product: { ...fresh.product, price: 0 } };
    const response = result(input);
    response.product.price = 0;
    const { client } = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)),
    );
    expect((await client.applyOcrIntake(input)).product.price).toBe(0);
  });

  it("does not send an intake without authentication", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken: () => null },
      fetchImplementation,
    });
    await expect(client.applyOcrIntake(existing)).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("canonicalizes decomposed Korean catalog fields without changing OCR input", async () => {
    const product = {
      name: "한글 상품",
      brandName: "가상 상표",
      option: "큰 규격",
      sku: "한글-SKU",
      price: 12000,
      category: "Bearings",
    };
    const input: AdminOcrIntakeInput = {
      ...fresh,
      product: {
        ...product,
        name: product.name.normalize("NFD"),
        brandName: product.brandName.normalize("NFD"),
        option: product.option.normalize("NFD"),
        sku: product.sku.normalize("NFD"),
      },
    };
    const response = result(input);
    const canonicalResponse = {
      ...response,
      product: {
        ...response.product,
        name: product.name,
        brandName: product.brandName,
        sizes: [product.option],
        sku: product.sku,
      },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(canonicalResponse));
    const { client } = createClient(fetchImplementation);
    expect((await client.applyOcrIntake(input)).product.name).toBe(product.name);
    expect(
      JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body)).product,
    ).toEqual(product);
    expect(input.product.name).toBe(product.name.normalize("NFD"));
  });

  it("snapshots an intake before asynchronous token retrieval", async () => {
    let release: (token: string) => void = () => {};
    const token = new Promise<string>((resolve) => {
      release = resolve;
    });
    const input = { ...existing, existing: { ...existing.existing } };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(result()));
    const client = createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken: () => token },
      fetchImplementation,
    });
    const pending = client.applyOcrIntake(input);
    input.quantity = 9;
    input.existing.version = 99;
    release("mock-admin-token");
    expect((await pending).receipt.quantity).toBe(3);
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
      action: "ocr-intake",
      ...existing,
    });
  });

  it("rejects accessor or serialization-hook commands without evaluating them", async () => {
    const getter = vi.fn(() => 3);
    const input = { ...existing };
    Object.defineProperty(input, "quantity", { get: getter, enumerable: true });
    const fetchImplementation = vi.fn<typeof fetch>();
    const { client } = createClient(fetchImplementation);
    await expect(client.applyOcrIntake(input)).rejects.toThrow(AdminApiResponseError);
    await expect(
      client.applyOcrIntake({
        ...existing,
        existing: Object.assign(
          Object.create({ toJSON: () => ({ stock: 999 }) }),
          existing.existing,
        ),
      }),
    ).rejects.toThrow(AdminApiResponseError);
    expect(getter).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    { ...existing, quantity: 0 },
    { ...existing, quantity: -1 },
    { ...existing, quantity: 1.5 },
    { ...existing, quantity: NaN },
    { ...existing, quantity: Infinity },
    { ...existing, quantity: 1000001 },
    { ...existing, operationId: "" },
    { ...existing, operationId: "x" },
    { ...existing, existing: { productId: "product-1", version: 0 } },
    { ...fresh, product: { ...fresh.product, price: "" } },
    { ...fresh, product: { ...fresh.product, price: -1 } },
    { ...fresh, product: { ...fresh.product, price: 0.5 } },
    { ...fresh, product: { ...fresh.product, price: NaN } },
    { ...fresh, product: { ...fresh.product, price: 100000001 } },
    { ...fresh, product: { ...fresh.product, category: "Unlisted" } },
    { ...fresh, product: { ...fresh.product, category: "" } },
    { ...fresh, product: { ...fresh.product, name: "x".repeat(161) } },
    { ...fresh, product: { ...fresh.product, brandName: " " } },
    { ...fresh, product: { ...fresh.product, option: "x".repeat(51) } },
    { ...fresh, product: { ...fresh.product, status: "PUBLISHED" } },
    { ...fresh, product: { ...fresh.product, stock: 9 } },
    { ...existing, sourceRows: [] },
    { ...existing, source: undefined },
    { ...existing, source: { jobId: "ocr-job-intake", rowIds: [] } },
    { ...existing, source: { jobId: "ocr-job-intake", rowIds: ["ocr_1", "ocr_1"] } },
    {
      ...existing,
      source: {
        jobId: "ocr-job-intake",
        rowIds: Array.from({ length: 97 }, (_, i) => `ocr_${i}`),
      },
    },
    { ...existing, source: { jobId: "ocr-job-intake", rowIds: ["bad row"] } },
    { ...existing, source: { jobId: "x", rowIds: ["ocr_1"] } },
  ])("rejects invalid intake before any request %#", async (input) => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const { client } = createClient(fetchImplementation);
    await expect(client.applyOcrIntake(input as AdminOcrIntakeInput)).rejects.toThrow(
      AdminApiResponseError,
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(["operationId", "kind", "quantity", "beforeStock", "afterStock", "replayed"])(
    "rejects missing receipt field %s",
    async (key) => {
      const response = result();
      delete (response.receipt as Record<string, unknown>)[key];
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)),
      );
      await expect(client.applyOcrIntake(existing)).rejects.toThrow(
        AdminApiResponseError,
      );
    },
  );

  it.each(["productId", "version", "inventoryQuantity"])(
    "rejects a receipt/product mismatch in %s",
    async (key) => {
      const response = result();
      (response.product as Record<string, unknown>)[key] =
        key === "productId" ? "another-product" : 99;
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)),
      );
      await expect(client.applyOcrIntake(existing)).rejects.toThrow(
        AdminApiResponseError,
      );
    },
  );

  it.each(["price", "category", "status"])(
    "rejects a mismatched or published new product %s",
    async (key) => {
      const response = result(fresh);
      (response.product as Record<string, unknown>)[key] =
        key === "price" ? 1 : key === "category" ? "Deck" : "PUBLISHED";
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)),
      );
      await expect(client.applyOcrIntake(fresh)).rejects.toThrow(AdminApiResponseError);
    },
  );

  it.each([
    "OCR_INTAKE_OPERATION_CONFLICT",
    "OCR_INTAKE_ROW_CONFLICT",
    "CATALOG_PRODUCT_DUPLICATE",
    "CATALOG_IDENTITY_CONFLICT",
    "CATALOG_PRODUCT_VERSION_CONFLICT",
  ])("returns safe %s without automatic retry or private bodies", async (code) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, private: "PRIVATE_CATALOG_DATA" }, { status: 409 }),
      );
    const { client } = createClient(fetchImplementation);
    await expect(client.applyOcrIntake(existing)).rejects.toMatchObject({
      status: 409,
      responseCode: code,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
