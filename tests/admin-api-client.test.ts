// 역할: 관리자 API 클라이언트가 Cognito 토큰을 사용하고, 민감한 OCR 입력을 브라우저에서 먼저 검증하는지 확인합니다.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiRequestError,
  AdminApiResponseError,
  AdminOcrInputError,
  AdminOcrDemoConnectionError,
  createAdminApiClient,
  getOcrRequestErrorMessage,
  isLocalOcrDevelopmentMode,
  isRemoteOcrDemoMode,
} from "@/lib/commerce/admin-api-client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import { getCheckoutApiConfig } from "@/lib/commerce/checkout-api-client";
import type {
  AdminOcrReviewRow,
  OcrColumnMapping,
  AdminOcrIntakeInput,
  AdminProductDraft,
} from "@/lib/admin-ui/types";

const apiConfig = getCheckoutApiConfig({
  NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.example.com/prod/",
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function createClient(fetchImplementation: typeof fetch) {
  const getAccessToken = vi.fn(() => "  cognito-admin-access-token  ");

  return {
    client: createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken },
      fetchImplementation,
    }),
    getAccessToken,
  };
}

const REVIEW_ROW: AdminOcrReviewRow = {
  id: "manual_1",
  sourceText: "",
  productName: "Manual product",
  brand: "",
  option: "",
  quantity: "2",
  confidence: 0.2,
  box: [
    [1, 2],
    [3, 4],
  ],
};

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

function saveClient(rawText = "Server canonical text") {
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        job: {
          jobId: "ocr-job-1",
          version: 7,
          rawText,
          rows: [REVIEW_ROW],
        },
      }),
      { status: 200 },
    ),
  );
  return { ...createClient(fetchImplementation), fetchImplementation };
}

describe("server canonical column mapping", () => {
  const mapping: OcrColumnMapping = {
    schemaVersion: 1,
    headerRow: 0,
    columns: { productName: 0, brand: null, option: null, quantity: 1 },
  };
  const analysis = {
    mode: "table",
    mapping,
    table: {
      headerRow: 0,
      columns: [
        { index: 0, label: "상품명", role: "productName" },
        { index: 1, label: "수량", role: "quantity" },
      ],
    },
  };
  const job = {
    jobId: "ocr-map",
    version: 2,
    rawText: "provider source",
    rows: [REVIEW_ROW],
    analysis,
  };
  it("sends only configuration and parses distinct preview then applied canonical job", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ preview: { ...job, version: 1 } }))
      .mockResolvedValueOnce(Response.json({ job }));
    const { client } = createClient(fetchImplementation);
    expect(
      await client.remapOcrReview({
        jobId: job.jobId,
        version: 1,
        mapping,
        preview: true,
      }),
    ).toMatchObject({ kind: "preview", preview: { version: 1, analysis } });
    expect(
      await client.remapOcrReview({
        jobId: job.jobId,
        version: 1,
        mapping,
        preview: false,
      }),
    ).toEqual({ kind: "saved", job });
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
      version: 1,
      mapping,
      preview: true,
    });
    expect(JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body))).toEqual({
      version: 1,
      mapping,
    });
  });
  it("recovers mapping conflicts through authenticated GET", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ job }));
    const { client } = createClient(fetchImplementation);
    expect(
      await client.remapOcrReview({
        jobId: job.jobId,
        version: 1,
        mapping,
        preview: false,
      }),
    ).toEqual({ kind: "conflict", job });
    expect(fetchImplementation.mock.calls[1][1]?.method).toBe("GET");
  });
  it("does not populate product names from unclassified source or legacy missing fields", async () => {
    const { client } = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          job: {
            ...job,
            analysis: { mode: "unclassified", reason: "header-not-found" },
            rows: [{ id: "p", sourceText: "Unclassified note" }],
          },
        }),
      ),
    );
    expect((await client.loadOcrReview(job.jobId)).rows[0]).toMatchObject({
      sourceText: "Unclassified note",
      productName: "",
      brand: "",
      option: "",
      quantity: "",
    });
  });
  it("rejects malformed mapping before transmission", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const { client } = createClient(fetchImplementation);
    await expect(
      client.remapOcrReview({
        jobId: job.jobId,
        version: 1,
        mapping: { ...mapping, rawText: "secret" } as OcrColumnMapping,
        preview: true,
      }),
    ).rejects.toBeInstanceOf(AdminApiResponseError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
  it.each([
    { ...job, jobId: "different-job" },
    { ...job, version: 1 },
  ])("rejects apply responses for another job or version (%#)", async (invalid) => {
    const { client } = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ job: invalid })),
    );
    await expect(
      client.remapOcrReview({ jobId: job.jobId, version: 1, mapping, preview: false }),
    ).rejects.toBeInstanceOf(AdminApiResponseError);
  });
  it.each([
    { ...analysis, mode: "unknown" },
    {
      ...analysis,
      table: {
        ...analysis.table,
        columns: [{ index: 4, label: "상품명", role: "productName" }],
      },
    },
    { ...analysis, mapping: { ...mapping, headerRow: 499 } },
    { ...analysis, table: undefined },
  ])(
    "rejects malformed analysis rather than claiming success (%#)",
    async (invalid) => {
      const { client } = createClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ job: { ...job, analysis: invalid } })),
      );
      await expect(client.loadOcrReview(job.jobId)).rejects.toBeInstanceOf(
        AdminApiResponseError,
      );
    },
  );
});

describe("canonical region mapping without a table header", () => {
  const mapping = {
    schemaVersion: 2 as const,
    parserVersion: 1 as const,
    kind: "regions" as const,
    image: { width: 1600, height: 820 },
    firstRow: {
      productName: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.25 },
      brand: null,
      option: null,
      quantity: { left: 0.7, top: 0.2, right: 0.8, bottom: 0.25 },
    },
    tableBottom: 0.8,
    secondRowY: null,
    quantityConfirmed: true,
  };
  const analysis = {
    mode: "table",
    mapping,
    region: {
      sourceTokenCount: 5,
      includedTokenCount: 2,
      excludedTokenCount: 3,
      warnings: ["region-excluded-tokens"],
    },
  };
  it("sends only normalized configuration and accepts headerless server previews", async () => {
    const preview = { jobId: "ocr-region", version: 1, rows: [REVIEW_ROW], analysis };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ preview }));
    const { client } = createClient(fetchImplementation);
    expect(
      await client.remapOcrReview({
        jobId: preview.jobId,
        version: 1,
        mapping,
        preview: true,
      }),
    ).toEqual({ kind: "preview", preview });
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
      version: 1,
      mapping,
      preview: true,
    });
  });
  it("rejects unconfirmed quantity and inconsistent source accounting", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        job: {
          jobId: "ocr-region",
          version: 1,
          rawText: "raw",
          rows: [REVIEW_ROW],
          analysis: {
            ...analysis,
            region: { ...analysis.region, excludedTokenCount: 99 },
          },
        },
      }),
    );
    const { client } = createClient(fetchImplementation);
    await expect(
      client.remapOcrReview({
        jobId: "ocr-region",
        version: 1,
        mapping: { ...mapping, quantityConfirmed: false },
        preview: true,
      }),
    ).rejects.toBeInstanceOf(AdminApiResponseError);
    expect(fetchImplementation).not.toHaveBeenCalled();
    await expect(client.loadOcrReview("ocr-region")).rejects.toBeInstanceOf(
      AdminApiResponseError,
    );
  });
  it("exposes only allowlisted region failure reasons, not provider text or private error values", async () => {
    for (const reason of ["region-footer-uncertain", "PRIVATE_USER_EMAIL"]) {
      const { client } = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json(
            {
              code: "OCR_JOB_MAPPING_UNUSABLE",
              analysis: { reason },
              rawText: "private source",
              token: "private token",
              message: "private message",
            },
            { status: 400 },
          ),
        ),
      );
      try {
        await client.remapOcrReview({
          jobId: "ocr-region",
          version: 1,
          mapping,
          preview: true,
        });
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AdminApiRequestError);
        expect((error as AdminApiRequestError).mappingReason).toBe(
          reason === "region-footer-uncertain" ? reason : undefined,
        );
        expect(getOcrRequestErrorMessage(error)).toContain("현재 검토본은 유지됩니다.");
        expect(JSON.stringify(error)).not.toMatch(/private|PRIVATE_USER/u);
      }
    }
  });
});

describe("development-only local OCR transport", () => {
  function localEnvironment(
    hostname = "localhost",
    url = "http://127.0.0.1:8011",
    mode = "development",
  ) {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_API_URL", url);
    vi.stubGlobal("window", { location: { hostname, protocol: "http:" } });
  }

  it("routes authenticated OCR recognition, save and conflict GET locally; other actions retain Commerce URL", async () => {
    localEnvironment();
    expect(isLocalOcrDevelopmentMode()).toBe(true);
    const canonical = {
      job: {
        jobId: "ocr-local-1",
        version: 2,
        rawText: "로컬 원문",
        rows: [REVIEW_ROW],
      },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(canonical, { status: 201 }))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json(canonical))
      .mockResolvedValueOnce(Response.json({ members: [] }));
    const { client, getAccessToken } = createClient(fetchImplementation);
    const file = new File(
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "intake.png",
      { type: "image/png" },
    );
    await client.recognizeInventory({ file });
    const result = await client.saveOcrReview({
      jobId: "ocr-local-1",
      version: 1,
      rawText: " \n ",
      rows: [REVIEW_ROW],
    });
    expect(result).toEqual({ kind: "conflict", job: canonical.job });
    await client.listMembers();
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8011/admin/ocr/jobs",
      "http://127.0.0.1:8011/admin/ocr/jobs/ocr-local-1",
      "http://127.0.0.1:8011/admin/ocr/jobs/ocr-local-1",
      "https://api.example.com/prod/admin/members",
    ]);
    expect(getAccessToken).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImplementation.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer cognito-admin-access-token",
      );
    const saved = JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body));
    expect(saved.rawText).toBe(" \n ");
    expect(saved.rows[0]).not.toHaveProperty("confidence");
    expect(saved.rows[0]).not.toHaveProperty("box");
  });

  it.each([
    ["localhost", "http://127.0.0.1:8011", "production"],
    ["remote.example", "http://127.0.0.1:8011", "development"],
    ["localhost", "https://remote.example:8011", "development"],
    ["localhost", "http://localhost:8010", "development"],
    ["localhost", "http://secret@localhost:8011", "development"],
    ["localhost", "http://localhost:8011/ocr", "development"],
    ["localhost", "http://localhost:8011/?query=1", "development"],
    ["localhost", "http://localhost:8011/#token", "development"],
  ])("ignores unsafe opt-in configuration %#", async (hostname, url, mode) => {
    localEnvironment(hostname, url, mode);
    expect(isLocalOcrDevelopmentMode()).toBe(false);
    const { client, fetchImplementation } = saveClient();
    await client.loadOcrReview("ocr-job-1");
    expect(fetchImplementation.mock.calls[0][0]).toBe(
      "https://api.example.com/prod/admin/ocr/jobs/ocr-job-1",
    );
  });

  it("keeps server-side rendering and disabled flags on the normal transport", async () => {
    localEnvironment();
    vi.stubGlobal("window", undefined);
    expect(isLocalOcrDevelopmentMode()).toBe(false);
    const first = saveClient();
    await first.client.loadOcrReview("ocr-job-1");
    expect(first.fetchImplementation.mock.calls[0][0]).toContain(
      "https://api.example.com",
    );
    localEnvironment();
    vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_ENABLED", "false");
    expect(isLocalOcrDevelopmentMode()).toBe(false);
    const second = saveClient();
    await second.client.loadOcrReview("ocr-job-1");
    expect(second.fetchImplementation.mock.calls[0][0]).toContain(
      "https://api.example.com",
    );
  });

  it("rejects missing authentication and unsafe rawText before local network calls", async () => {
    localEnvironment();
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken: () => null },
      fetchImplementation,
    });
    await expect(client.loadOcrReview("ocr-local-1")).rejects.toThrow();
    await expect(
      client.saveOcrReview({
        jobId: "ocr-local-1",
        version: 1,
        rows: [REVIEW_ROW],
        rawText: "\0",
      }),
    ).rejects.toThrow(AdminApiResponseError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("explicit pinned HTTPS OCR demo transport", () => {
  const demoApi = "https://ocr-relay.demo.test";
  const mapping: OcrColumnMapping = {
    schemaVersion: 1,
    headerRow: 0,
    columns: { productName: 0, brand: null, option: null, quantity: 1 },
  };
  const demoJob = {
    jobId: "ocr-demo-1",
    version: 2,
    rawText: "Synthetic PC source",
    rows: [REVIEW_ROW],
    analysis: {
      mode: "table",
      mapping,
      table: {
        headerRow: 0,
        columns: [
          { index: 0, label: "Item", role: "productName" },
          { index: 1, label: "Qty", role: "quantity" },
        ],
      },
    },
  };
  function demoEnvironment(
    pageOrigin = "https://paradays.web.app",
    url = demoApi,
    allowedOrigin = demoApi,
    enabled = "true",
  ) {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_ENABLED", enabled);
    vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_API_URL", url);
    vi.stubEnv("NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN", allowedOrigin);
    const location = new URL(pageOrigin);
    vi.stubGlobal("window", {
      location: {
        origin: location.origin,
        protocol: location.protocol,
        hostname: location.hostname,
        search: "?ocrApi=https://attacker.test",
      },
      localStorage: { getItem: vi.fn(() => "https://attacker.test") },
    });
  }

  it("routes only authenticated OCR including remap/conflict GET to the pinned demo", async () => {
    demoEnvironment();
    expect(isRemoteOcrDemoMode()).toBe(true);
    expect(isLocalOcrDevelopmentMode()).toBe(false);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ job: { ...demoJob, version: 1 } }, { status: 201 }),
      )
      .mockResolvedValueOnce(Response.json({ job: demoJob }))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ job: demoJob }))
      .mockResolvedValueOnce(Response.json({ preview: demoJob }))
      .mockResolvedValueOnce(Response.json({ job: { ...demoJob, version: 3 } }))
      .mockResolvedValueOnce(Response.json({ members: [] }));
    const { client, getAccessToken } = createClient(fetchImplementation);
    await client.recognizeInventory({
      file: new File(
        [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        "synthetic.png",
        { type: "image/png" },
      ),
    });
    await client.loadOcrReview(demoJob.jobId);
    expect(
      await client.saveOcrReview({
        jobId: demoJob.jobId,
        version: 1,
        rows: [REVIEW_ROW],
      }),
    ).toEqual({ kind: "conflict", job: demoJob });
    expect(
      await client.remapOcrReview({
        jobId: demoJob.jobId,
        version: 2,
        mapping,
        preview: true,
      }),
    ).toMatchObject({ kind: "preview", preview: { version: 2 } });
    expect(
      await client.remapOcrReview({
        jobId: demoJob.jobId,
        version: 2,
        mapping,
        preview: false,
      }),
    ).toMatchObject({ kind: "saved", job: { version: 3 } });
    await client.listMembers();
    expect(getAccessToken).toHaveBeenCalledTimes(7);
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      `${demoApi}/admin/ocr/jobs`,
      ...Array.from({ length: 5 }, () => `${demoApi}/admin/ocr/jobs/${demoJob.jobId}`),
      "https://api.example.com/prod/admin/members",
    ]);
    for (const [, init] of fetchImplementation.mock.calls.slice(0, 6)) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer cognito-admin-access-token",
      );
      expect(init).toMatchObject({
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(String(init?.body ?? "")).not.toMatch(
        /confidence|ownerSub|sourceRows|box/u,
      );
    }
    expect(fetchImplementation.mock.calls[6][1]).not.toHaveProperty("signal");
    expect(fetchImplementation.mock.calls[6][1]).not.toHaveProperty("redirect");
    expect(window.localStorage.getItem).not.toHaveBeenCalled();
  });

  it.each([
    ["https://paradays.web.app", demoApi, demoApi, "false"],
    ["https://paradays.web.app", demoApi, demoApi, "TRUE"],
    ["http://paradays.web.app", demoApi, demoApi, "true"],
    ["https://paradays.web.app.evil.test", demoApi, demoApi, "true"],
    ["https://other.web.app", demoApi, demoApi, "true"],
    ["http://localhost:3138", demoApi, demoApi, "true"],
    [
      "https://paradays.web.app",
      "http://ocr-relay.demo.test",
      "http://ocr-relay.demo.test",
      "true",
    ],
    ["https://paradays.web.app", demoApi, "https://different.demo.test", "true"],
    ["https://paradays.web.app", demoApi, `${demoApi}/`, "true"],
    ["https://paradays.web.app", demoApi, "", "true"],
    ["https://paradays.web.app", `${demoApi}/admin`, demoApi, "true"],
    [
      "https://paradays.web.app",
      `${demoApi}?url=https://attacker.test`,
      demoApi,
      "true",
    ],
    ["https://paradays.web.app", `${demoApi}#token`, demoApi, "true"],
    ["https://paradays.web.app", "https://secret@ocr-relay.demo.test", demoApi, "true"],
    [
      "https://paradays.web.app",
      "https://ocr-relay.demo.test:8010",
      "https://ocr-relay.demo.test:8010",
      "true",
    ],
    ["https://paradays.web.app", "https://127.0.0.1", "https://127.0.0.1", "true"],
    ["https://paradays.web.app", "https://[::1]", "https://[::1]", "true"],
    [
      "https://paradays.web.app",
      "https://device.local",
      "https://device.local",
      "true",
    ],
    [
      "https://paradays.web.app",
      "https://device.localhost",
      "https://device.localhost",
      "true",
    ],
    [
      "https://paradays.web.app",
      "https://paradays.web.app",
      "https://paradays.web.app",
      "true",
    ],
    [
      "https://paradays.web.app",
      "https://ocr-relay.demo.test.",
      "https://ocr-relay.demo.test.",
      "true",
    ],
    ["https://paradays.web.app", "not-a-url", demoApi, "true"],
  ])(
    "keeps unsafe or disabled demo configuration on Commerce %#",
    async (pageOrigin, url, allowedOrigin, enabled) => {
      demoEnvironment(pageOrigin, url, allowedOrigin, enabled);
      expect(isRemoteOcrDemoMode()).toBe(false);
      const { client, fetchImplementation } = saveClient();
      await client.loadOcrReview("ocr-job-1");
      expect(fetchImplementation.mock.calls[0][0]).toBe(
        "https://api.example.com/prod/admin/ocr/jobs/ocr-job-1",
      );
    },
  );

  it("does not enable demo during SSR or weaken the local production guard", async () => {
    demoEnvironment();
    vi.stubGlobal("window", undefined);
    expect(isRemoteOcrDemoMode()).toBe(false);
    const first = saveClient();
    await first.client.loadOcrReview("ocr-job-1");
    expect(first.fetchImplementation.mock.calls[0][0]).toContain(
      "https://api.example.com",
    );
    demoEnvironment("http://localhost:3138");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_OCR_API_URL", "http://127.0.0.1:8011");
    expect(isRemoteOcrDemoMode()).toBe(false);
    expect(isLocalOcrDevelopmentMode()).toBe(false);
  });

  it("requires authentication before sending demo data", async () => {
    demoEnvironment();
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken: () => null },
      fetchImplementation,
    });
    await expect(client.loadOcrReview("ocr-demo-1")).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("bounds the entire demo fetch including a stalled JSON response to 120 seconds", async () => {
    demoEnvironment();
    vi.useFakeTimers();
    try {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
      const { client } = createClient(fetchImplementation);
      const result = client.loadOcrReview("ocr-demo-1");
      const assertion = expect(result).rejects.toMatchObject({
        code: "OCR_DEMO_CONNECTION_FAILED",
        timedOut: true,
      });
      await vi.advanceTimersByTimeAsync(120000);
      await assertion;
      expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports offline demo without leaking a failing URL, token, or upstream message", async () => {
    demoEnvironment();
    const { client } = createClient(
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new Error("PRIVATE_TOKEN https://private-host.test IMAGE_BYTES"),
        ),
    );
    try {
      await client.loadOcrReview("ocr-demo-1");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminOcrDemoConnectionError);
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /PRIVATE_TOKEN|private-host|IMAGE_BYTES/u,
      );
      expect(getOcrRequestErrorMessage(error)).toContain("HTTPS 중계");
      expect(getOcrRequestErrorMessage(error)).toContain("현재 검토본은 유지됩니다.");
    }
  });

  it.each([
    [403, "ADMIN_ROLE_REQUIRED", "admin 그룹"],
    [403, "LOCAL_OCR_ORIGIN_REQUIRED", "Firebase 접속 허용"],
    [408, "LOCAL_OCR_BODY_TIMEOUT", "이미지 전송 시간"],
    [429, "LOCAL_OCR_LIMIT_REACHED", "임시 사용 한도"],
    [502, "OCR_PROVIDER_REQUEST_FAILED", "담당 PC와 HTTPS 중계"],
  ])("keeps safe actionable demo errors for %s %s", async (status, code, message) => {
    demoEnvironment();
    const { client } = createClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code, private: "PRIVATE_SERVER_BODY" }, { status }),
        ),
    );
    try {
      await client.loadOcrReview("ocr-demo-1");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(getOcrRequestErrorMessage(error)).toContain(message);
      expect(JSON.stringify(error)).not.toContain("PRIVATE_SERVER_BODY");
    }
  });
});

describe("OCR error messages in English", () => {
  const ocrError = (status: number, code?: string, reason?: string) =>
    new AdminApiRequestError(status, "admin/ocr/jobs", code, reason);

  it.each([
    [new AdminOcrDemoConnectionError(true), "2-minute wait"],
    [new AdminOcrDemoConnectionError(false), "HTTPS relay"],
    [ocrError(401), "sign-in has expired"],
    [ocrError(403, "LOCAL_OCR_ORIGIN_REQUIRED"), "localhost:3138"],
    [ocrError(403, "ADMIN_ROLE_REQUIRED"), "admin group"],
    [ocrError(429, "OCR_PROVIDER_BUSY"), "usage limit"],
    [ocrError(408, "LOCAL_OCR_BODY_TIMEOUT"), "timed out"],
    [ocrError(400, "OCR_IMAGE_INVALID"), "image format"],
    [ocrError(413, "OCR_IMAGE_TOO_LARGE"), "4MiB"],
    [ocrError(503, "OCR_JOB_CONFIGURATION_UNAVAILABLE"), "settings are empty"],
    [ocrError(502, "OCR_PROVIDER_REQUEST_FAILED"), "PaddleOCR service failed"],
    [ocrError(502, "OCR_PROVIDER_RESPONSE_INVALID"), "rec_texts"],
    [ocrError(503, "OCR_JOB_STORAGE_UNAVAILABLE"), "DynamoDB"],
    [ocrError(400, "OCR_JOB_RAW_TEXT_INVALID"), "100,000"],
    [ocrError(413, "OCR_JOB_TOO_LARGE"), "larger than can be saved"],
    [ocrError(400, "OCR_JOB_MAPPING_UNUSABLE", "missing-geometry"), "position data"],
    [ocrError(400, "OCR_JOB_MAPPING_INVALID"), "Could not determine product rows"],
    [ocrError(400, "OCR_JOB_SOURCE_ROWS_UNAVAILABLE"), "no original coordinates"],
    [ocrError(500), "OCR server processing failed"],
    [ocrError(400), "The OCR request failed"],
  ])("maps %o to English without Korean", (error, text) => {
    const message = getOcrRequestErrorMessage(error, "en");
    expect(message).toContain(text);
    expect(message).not.toMatch(/[가-힣]/u);
  });

  it("keeps the region reason and the kept-review note together in English", () => {
    expect(
      getOcrRequestErrorMessage(
        ocrError(400, "OCR_JOB_MAPPING_UNUSABLE", "quantity-column-conflict"),
        "en",
      ),
    ).toBe(
      "Price, number or status areas cannot be used as quantity. Select the actual quantity area. The current review is kept.",
    );
    expect(
      getOcrRequestErrorMessage(
        ocrError(400, "OCR_JOB_MAPPING_UNUSABLE", "quantity-column-conflict"),
      ),
    ).toBe(
      "금액·번호·상태 영역은 수량으로 사용할 수 없습니다. 실제 수량 영역을 선택해 주세요. 현재 검토본은 유지됩니다.",
    );
  });
});

describe("createAdminApiClient", () => {
  it("keeps legacy overview payloads compatible and validates optional live metrics", async () => {
    const baseMetrics = {
      asOf: "2026-10-12T01:00:00.000Z",
      timezone: "Asia/Seoul",
      todayOrderCount: 3,
      lowStockCount: 2,
      lowStockThreshold: 5,
      activeCouponCount: 4,
      marketingConsentCount: 7,
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...baseMetrics,
          todayPaidRevenue: 51_000,
          todaySoldItemCount: 4,
          todayNewMemberCount: 2,
        }),
      )
      .mockResolvedValueOnce(Response.json(baseMetrics));
    const { client } = createClient(fetchImplementation);

    await expect(client.loadOverviewMetrics()).resolves.toEqual({
      ...baseMetrics,
      todayPaidRevenue: 51_000,
      todaySoldItemCount: 4,
      todayNewMemberCount: 2,
    });
    await expect(client.loadOverviewMetrics()).resolves.toEqual(baseMetrics);
  });

  it("rejects malformed optional overview metrics instead of rendering an invented value", async () => {
    const { client } = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          asOf: "2026-10-12T01:00:00.000Z",
          timezone: "Asia/Seoul",
          todayOrderCount: 3,
          todayPaidRevenue: -1,
          lowStockCount: 2,
          lowStockThreshold: 5,
          activeCouponCount: 4,
          marketingConsentCount: 7,
        }),
      ),
    );

    await expect(client.loadOverviewMetrics()).rejects.toBeInstanceOf(
      AdminApiResponseError,
    );
  });

  it("edited rawText is sent exactly with authenticated PATCH and editable-row allowlist", async () => {
    const { client, fetchImplementation, getAccessToken } = saveClient();
    const rawText = "  수정한 원문\n두 번째 줄  ";
    const result = await client.saveOcrReview({
      jobId: "ocr-job-1",
      version: 6,
      rows: [REVIEW_ROW],
      rawText,
    });
    expect(result).toMatchObject({
      kind: "saved",
      job: { rawText: "Server canonical text", version: 7 },
    });
    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe("https://api.example.com/prod/admin/ocr/jobs/ocr-job-1");
    expect(request?.method).toBe("PATCH");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer cognito-admin-access-token",
    );
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request?.body))).toEqual({
      version: 6,
      rawText,
      rows: [
        {
          id: "manual_1",
          sourceText: "",
          productName: "Manual product",
          brand: "",
          option: "",
          quantity: "2",
        },
      ],
    });
  });

  it("omitted or undefined rawText is absent from PATCH JSON", async () => {
    for (const optional of [{}, { rawText: undefined }]) {
      const { client, fetchImplementation } = saveClient();
      await client.saveOcrReview({
        jobId: "ocr-job-1",
        version: 6,
        rows: [REVIEW_ROW],
        ...optional,
      });
      expect(
        JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body)),
      ).not.toHaveProperty("rawText");
    }
  });

  it.each(["", "  \n  ", "가나다", "😀".repeat(50_000)])(
    "accepts empty/whitespace/Unicode rawText without normalization (case %#)",
    async (rawText) => {
      const { client, fetchImplementation } = saveClient(rawText);
      const result = await client.saveOcrReview({
        jobId: "ocr-job-1",
        version: 6,
        rows: [REVIEW_ROW],
        rawText,
      });
      expect(result.job.rawText).toBe(rawText);
      expect(
        JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body)).rawText,
      ).toBe(rawText);
    },
  );

  it("rawText type, NUL and untrimmed UTF-16 bounds fail before auth or fetch", async () => {
    const { client, fetchImplementation, getAccessToken } = saveClient();
    for (const rawText of [
      null,
      false,
      12,
      {},
      [],
      "\u0000",
      "x".repeat(100_001),
      " ".repeat(100_001),
      "😀".repeat(50_001),
    ]) {
      await expect(
        client.saveOcrReview({
          jobId: "ocr-job-1",
          version: 6,
          rows: [REVIEW_ROW],
          rawText: rawText as string,
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("canonical response containing NUL in rawText is rejected", async () => {
    const { client } = saveClient("bad\u0000text");
    await expect(
      client.saveOcrReview({ jobId: "ocr-job-1", version: 6, rows: [REVIEW_ROW] }),
    ).rejects.toBeInstanceOf(AdminApiResponseError);
  });

  it.each([
    [400, "OCR_JOB_RAW_TEXT_INVALID"],
    [413, "OCR_JOB_TOO_LARGE"],
  ] as const)(
    "preserves allowlisted rawText/storage error %i without private details",
    async (status, code) => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code, privateDetails: "must-not-expose" }), {
          status,
        }),
      );
      const { client } = createClient(fetchImplementation);
      const error = await client
        .saveOcrReview({
          jobId: "ocr-job-1",
          version: 6,
          rows: [REVIEW_ROW],
          rawText: "edited",
        })
        .catch((error) => error);
      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({ status, responseCode: code });
      expect(error.message).not.toContain("must-not-expose");
      expect(getOcrRequestErrorMessage(error)).toBeDefined();
      expect(fetchImplementation).toHaveBeenCalledOnce();
    },
  );
  it("Cognito access token을 사용해 상품 등록 endpoint에 정규화된 draft를 전송함", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ product: { productId: "product-1" } }), {
        status: 201,
      }),
    );
    const { client, getAccessToken } = createClient(fetchImplementation);

    await expect(
      client.saveProductDraft({
        name: "PRADAYS Image Deck",
        brand: "PRADAYS",
        category: "Decks",
        sku: "",
        price: "109000",
        compareAtPrice: "",
        stock: "",
        imageUrl: "/images/products/pradays-image-deck.jpg",
        sizes: "8.25\u2033",
        description: "이미지 데크",
        isVisible: true,
        isFeatured: false,
      }),
    ).resolves.toBeUndefined();

    expect(getAccessToken).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0];
    const headers = new Headers(request?.headers);

    expect(url).toBe("https://api.example.com/prod/admin/catalog/products");
    expect(request).toMatchObject({ method: "POST" });
    expect(headers.get("authorization")).toBe("Bearer cognito-admin-access-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(request?.body))).toEqual({
      name: "PRADAYS Image Deck",
      brand: "PRADAYS",
      category: "Decks",
      price: "109000",
      stock: "0",
      imageUrl: "/images/products/pradays-image-deck.jpg",
      sizes: "8.25\u2033",
      description: "이미지 데크",
      isVisible: true,
      isFeatured: false,
    });
  });

  describe("deck size spec", () => {
    const deckSpec = {
      nose: 6.875,
      tail: 6.5,
      width: 8.5,
      length: 31.75,
      wheelbase: 14.25,
    };
    const savedProduct = (version: number, spec?: typeof deckSpec) => ({
      productId: "prd_deck",
      name: "Deck",
      brandName: "Quasi",
      category: "Deck",
      price: 107000,
      inventoryQuantity: 3,
      status: "PUBLISHED",
      featured: false,
      version,
      description: [],
      sizes: ["8.5"],
      ...(spec ? { deckSpec: spec } : {}),
    });

    it("PATCHes only version and deckSpec and returns the updated row", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ product: savedProduct(4, deckSpec) }), {
          status: 200,
        }),
      );
      const { client } = createClient(fetchImplementation);

      const product = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec,
      });

      expect(product).toMatchObject({ id: "prd_deck", version: 4, deckSpec });
      const [url, request] = fetchImplementation.mock.calls[0];
      expect(url).toBe("https://api.example.com/prod/admin/catalog/products/prd_deck");
      expect(request).toMatchObject({ method: "PATCH" });
      expect(JSON.parse(String(request?.body))).toEqual({ version: 3, deckSpec });
    });

    it("sends null to delete and rejects a response that still has a spec", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ product: savedProduct(4) }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ product: savedProduct(5, deckSpec) }), {
            status: 200,
          }),
        );
      const { client } = createClient(fetchImplementation);

      const cleared = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: null,
      });
      expect(cleared).not.toHaveProperty("deckSpec");
      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        deckSpec: null,
      });

      await expect(
        client.updateProductDeckSpec({ id: "prd_deck", version: 4, deckSpec: null }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects a delete response that carries a malformed spec", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ product: { ...savedProduct(4), deckSpec: {} } }),
          {
            status: 200,
          },
        ),
      );
      const { client } = createClient(fetchImplementation);

      await expect(
        client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec: null }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects invalid inches before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);

      for (const invalid of [
        { ...deckSpec, nose: 0 },
        { ...deckSpec, tail: Number.NaN },
        { ...deckSpec, length: 101 },
      ]) {
        await expect(
          client.updateProductDeckSpec({
            id: "prd_deck",
            version: 3,
            deckSpec: invalid,
          }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    const optionSpec = { ...deckSpec, width: 8.25, wheelbase: 14 };
    const respond = (product: object) =>
      new Response(JSON.stringify({ product }), { status: 200 });

    it("saves one size option with sizeDeckSpec and parses the option map", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        respond({
          ...savedProduct(4, deckSpec),
          sizes: ["8.25", "8.5"],
          deckSpecsBySize: { "8.25": optionSpec },
        }),
      );
      const { client } = createClient(fetchImplementation);

      const product = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: optionSpec,
        size: "8.25",
      });

      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.25",
        sizeDeckSpec: optionSpec,
      });
      expect(product.deckSpec).toEqual(deckSpec);
      expect(product.deckSpecsBySize).toEqual({ "8.25": optionSpec });
    });

    it("rejects an option save answered by a server without option charts", async () => {
      // An older server ignores size and sizeDeckSpec and only bumps the version.
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(respond(savedProduct(4, deckSpec)));
      const { client } = createClient(fetchImplementation);

      await expect(
        client.updateProductDeckSpec({
          id: "prd_deck",
          version: 3,
          deckSpec: optionSpec,
          size: "8.5",
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("deletes one size option with null and checks only that option", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          respond({
            ...savedProduct(4, deckSpec),
            deckSpecsBySize: { "8.0": optionSpec },
          }),
        )
        .mockResolvedValueOnce(
          respond({ ...savedProduct(5), deckSpecsBySize: { "8.5": optionSpec } }),
        );
      const { client } = createClient(fetchImplementation);

      const cleared = await client.updateProductDeckSpec({
        id: "prd_deck",
        version: 3,
        deckSpec: null,
        size: "8.5",
      });
      expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toEqual({
        version: 3,
        size: "8.5",
        sizeDeckSpec: null,
      });
      expect(cleared.deckSpecsBySize).toEqual({ "8.0": optionSpec });

      await expect(
        client.updateProductDeckSpec({
          id: "prd_deck",
          version: 4,
          deckSpec: null,
          size: "8.5",
        }),
      ).rejects.toBeInstanceOf(AdminApiResponseError);
    });

    it("rejects an empty or oversized option name before authentication or fetch", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const { client, getAccessToken } = createClient(fetchImplementation);

      for (const size of ["", "   ", "x".repeat(51), 8.5 as unknown as string]) {
        await expect(
          client.updateProductDeckSpec({ id: "prd_deck", version: 3, deckSpec, size }),
        ).rejects.toBeInstanceOf(AdminApiResponseError);
      }
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("keeps only well-formed option charts when listing products", async () => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              {
                ...savedProduct(4),
                deckSpecsBySize: {
                  "8.25": optionSpec,
                  "8.5": { ...optionSpec, nose: 0 },
                },
              },
              {
                ...savedProduct(4),
                productId: "prd_bad",
                deckSpecsBySize: { "8.5": {} },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const { client } = createClient(fetchImplementation);

      const [kept, dropped] = await client.listCatalogProducts();
      expect(kept.deckSpecsBySize).toEqual({ "8.25": optionSpec });
      expect(dropped).not.toHaveProperty("deckSpecsBySize");
    });
  });

  describe("explicit product comparison price serialization", () => {
    const draft: AdminProductDraft = {
      name: "Synthetic product",
      brand: "Synthetic brand",
      category: "Deck",
      sku: "preserved-SKU",
      price: "109000",
      compareAtPrice: "",
      stock: "13",
      imageUrl: "/images/product-placeholder.svg",
      sizes: "8.25”, Custom / Mixed CASE",
      description: "Synthetic description",
      isVisible: false,
      isFeatured: true,
      nameI18n: { ko: "합성 상품", en: "Synthetic product" },
      descriptionI18n: { ko: ["합성 설명"], en: ["Synthetic description"] },
      sourceLocale: "ko",
    };

    it.each([false, true])(
      "sends an explicit empty comparison price for a versioned edit without altering publication %s",
      async (isVisible) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client, getAccessToken } = createClient(fetchImplementation);
        await client.saveProductDraft({
          ...draft,
          productId: "product/legacy +code",
          version: 7,
          isVisible,
        });
        expect(getAccessToken).toHaveBeenCalledOnce();
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe(
          "https://api.example.com/prod/admin/catalog/products/product%2Flegacy%20%2Bcode",
        );
        expect(request?.method).toBe("PATCH");
        expect(new Headers(request?.headers).get("authorization")).toBe(
          "Bearer cognito-admin-access-token",
        );
        expect(JSON.parse(String(request?.body))).toEqual({
          ...draft,
          compareAtPrice: "",
          isVisible,
          version: 7,
        });
        expect(String(request?.body)).toContain('"compareAtPrice":""');
      },
    );

    it.each(["129000", " 129000 ", "0", "not-a-number"])(
      "preserves the comparison price string without silent parsing for edit %j",
      async (compareAtPrice) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({
          ...draft,
          productId: "product-1",
          version: 8,
          compareAtPrice,
        });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe(
          "https://api.example.com/prod/admin/catalog/products/product-1",
        );
        expect(request?.method).toBe("PATCH");
        expect(JSON.parse(String(request?.body))).toEqual({
          ...draft,
          compareAtPrice,
          version: 8,
        });
      },
    );

    it.each(["129000", " 129000 ", "0", "not-a-number"])(
      "preserves a supplied new-product comparison price string %j",
      async (compareAtPrice) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({ ...draft, compareAtPrice });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe("https://api.example.com/prod/admin/catalog/products");
        expect(request?.method).toBe("POST");
        expect(JSON.parse(String(request?.body))).toEqual({ ...draft, compareAtPrice });
      },
    );

    it.each([{}, { productId: "legacy-without-version" }, { version: 7 }])(
      "keeps blank comparison price omitted on the existing create path %j",
      async (identity) => {
        const fetchImplementation = vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({}));
        const { client } = createClient(fetchImplementation);
        await client.saveProductDraft({ ...draft, ...identity });
        expect(fetchImplementation).toHaveBeenCalledOnce();
        const [url, request] = fetchImplementation.mock.calls[0];
        expect(url).toBe("https://api.example.com/prod/admin/catalog/products");
        expect(request?.method).toBe("POST");
        const body = JSON.parse(String(request?.body));
        expect(body).not.toHaveProperty("compareAtPrice");
        expect(body).not.toHaveProperty("version");
        expect(body).not.toHaveProperty("productId");
        const { compareAtPrice: omitted, ...expected } = draft;
        expect(omitted).toBe("");
        expect(body).toEqual(expected);
      },
    );

    it("does not send an explicit removal without an authenticated administrator token", async () => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const client = createAdminApiClient({
        config: apiConfig,
        authorizationTokenProvider: { getAccessToken: () => null },
        fetchImplementation,
      });
      await expect(
        client.saveProductDraft({ ...draft, productId: "product-1", version: 7 }),
      ).rejects.toThrow();
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("propagates a rejected removal once without retrying or altering the draft", async () => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "CATALOG_PRODUCT_VERSION_CONFLICT" }, { status: 409 }),
        );
      const { client } = createClient(fetchImplementation);
      const input = Object.freeze({ ...draft, productId: "product-1", version: 7 });
      await expect(client.saveProductDraft(input)).rejects.toMatchObject({
        status: 409,
      });
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(
        JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body)),
      ).toMatchObject({
        compareAtPrice: "",
        version: 7,
      });
      expect(input).toMatchObject({ compareAtPrice: "", version: 7 });
    });
  });

  it("회원 권한 변경은 username을 URL 경로에 인코딩하고 보호된 DELETE body만 전송함", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { client } = createClient(fetchImplementation);

    await expect(
      client.updateMemberGroup({
        username: "  crew/member  ",
        group: "support",
        add: false,
      }),
    ).resolves.toBeUndefined();

    const [url, request] = fetchImplementation.mock.calls[0];
    const headers = new Headers(request?.headers);

    expect(url).toBe("https://api.example.com/prod/admin/members/crew%2Fmember/groups");
    expect(request).toMatchObject({ method: "DELETE" });
    expect(headers.get("authorization")).toBe("Bearer cognito-admin-access-token");
    expect(JSON.parse(String(request?.body))).toEqual({ group: "support" });
  });

  it("API Gateway의 거절 응답은 응답 본문 없이 status와 endpoint를 가진 오류로 반환함", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"internal":"do not expose"}', { status: 403 }));
    const { client } = createClient(fetchImplementation);

    await expect(
      client.saveBrandDraft({ name: "PRADAYS", memo: "브랜드 소개" }),
    ).rejects.toMatchObject({
      name: "AdminApiRequestError",
      code: "ADMIN_API_REQUEST_FAILED",
      status: 403,
      endpoint: "admin/brands",
    } satisfies Partial<AdminApiRequestError>);
  });

  it("유효한 PNG signature를 가진 OCR 파일만 base64 payload로 관리자 endpoint에 보냄", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            jobId: "ocr-job-1",
            version: 1,
            rawText: "PRADAYS Image Deck",
            rows: [
              {
                id: "row-1",
                sourceText: "PRADAYS Image Deck",
                confidence: 0.98,
                box: [
                  [12, 24],
                  [240, 24],
                  [240, 68],
                  [12, 68],
                ],
                productName: "PRADAYS Image Deck",
                brand: "PRADAYS",
                option: "8.25\u2033",
                quantity: "3",
              },
            ],
          },
        }),
        { status: 201 },
      ),
    );
    const { client } = createClient(fetchImplementation);
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "arrival.png",
      { type: "image/png" },
    );

    await expect(client.recognizeInventory({ file })).resolves.toEqual({
      jobId: "ocr-job-1",
      version: 1,
      rawText: "PRADAYS Image Deck",
      rows: [
        {
          id: "row-1",
          sourceText: "PRADAYS Image Deck",
          confidence: 0.98,
          box: [
            [12, 24],
            [240, 24],
            [240, 68],
            [12, 68],
          ],
          productName: "PRADAYS Image Deck",
          brand: "PRADAYS",
          option: "8.25\u2033",
          quantity: "3",
        },
      ],
    });

    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe("https://api.example.com/prod/admin/ocr/jobs");
    expect(request).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(request?.body))).toEqual({
      fileName: "arrival.png",
      mimeType: "image/png",
      imageBase64: "iVBORw0KGgo=",
    });
  });

  it("OCR 이미지의 magic byte 또는 크기가 허용 범위를 벗어나면 API를 호출하지 않음", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const { client } = createClient(fetchImplementation);
    const malformedPng = new File(
      [new Uint8Array([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "not-a-real-png.png",
      { type: "image/png" },
    );
    const oversizedPng = new File(
      [new Uint8Array(OCR_INPUT_LIMITS.maxInlineImageBytes + 1)],
      "too-large.png",
      { type: "image/png" },
    );

    await expect(
      client.recognizeInventory({ file: malformedPng }),
    ).rejects.toBeInstanceOf(AdminOcrInputError);
    await expect(
      client.recognizeInventory({ file: oversizedPng }),
    ).rejects.toMatchObject({
      name: "AdminOcrInputError",
      reason: "INLINE_PAYLOAD_TOO_LARGE",
    } satisfies Partial<AdminOcrInputError>);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("OCR 검토 PATCH 성공은 서버 canonical job과 version을 그대로 반환하고 provider metadata를 다시 보내지 않음", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            jobId: "ocr-job-1",
            version: 7,
            rawText: "PRADAYS Image Deck",
            rows: [
              {
                id: "row-1",
                sourceText: "PRADAYS Image Deck",
                confidence: 0.94,
                box: [
                  [18, 30],
                  [260, 30],
                  [260, 72],
                  [18, 72],
                ],
                productName: "PRADAYS Image Deck (canonical)",
                brand: "PRADAYS",
                option: "8.25\u2033",
                quantity: "8",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const { client } = createClient(fetchImplementation);

    await expect(
      client.saveOcrReview({
        jobId: "ocr-job-1",
        version: 6,
        rows: [
          {
            id: "row-1",
            sourceText: "PRADAYS Image Deck",
            confidence: 0.12,
            box: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            productName: "local draft that server normalizes",
            brand: "PRADAYS",
            option: "8.25\u2033",
            quantity: "3",
          },
        ],
      }),
    ).resolves.toEqual({
      kind: "saved",
      job: {
        jobId: "ocr-job-1",
        version: 7,
        rawText: "PRADAYS Image Deck",
        rows: [
          {
            id: "row-1",
            sourceText: "PRADAYS Image Deck",
            confidence: 0.94,
            box: [
              [18, 30],
              [260, 30],
              [260, 72],
              [18, 72],
            ],
            productName: "PRADAYS Image Deck (canonical)",
            brand: "PRADAYS",
            option: "8.25\u2033",
            quantity: "8",
          },
        ],
      },
    });

    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe("https://api.example.com/prod/admin/ocr/jobs/ocr-job-1");
    expect(request).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(request?.body))).toEqual({
      version: 6,
      rows: [
        {
          id: "row-1",
          sourceText: "PRADAYS Image Deck",
          productName: "local draft that server normalizes",
          brand: "PRADAYS",
          option: "8.25\u2033",
          quantity: "3",
        },
      ],
    });
  });

  it("OCR 검토 PATCH가 409이면 응답 본문을 신뢰하지 않고 최신 job을 GET해 충돌 결과로 반환함", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "OCR_JOB_VERSION_CONFLICT",
            job: { jobId: "ocr-job-1", version: 7 },
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job: {
              jobId: "ocr-job-1",
              version: 8,
              rawText: "newer review from another admin",
              rows: [
                {
                  id: "row-1",
                  sourceText: "PRADAYS Image Deck",
                  confidence: 0.91,
                  box: [
                    [20, 32],
                    [264, 32],
                    [264, 74],
                    [20, 74],
                  ],
                  productName: "Server 최신값",
                  brand: "PRADAYS",
                  option: "8.5\u2033",
                  quantity: "12",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    const { client } = createClient(fetchImplementation);

    await expect(
      client.saveOcrReview({
        jobId: "ocr-job-1",
        version: 6,
        rows: [
          {
            id: "row-1",
            sourceText: "PRADAYS Image Deck",
            productName: "local stale value",
            brand: "PRADAYS",
            option: "8.25\u2033",
            quantity: "3",
          },
        ],
        rawText: "local stale raw text",
      }),
    ).resolves.toEqual({
      kind: "conflict",
      job: {
        jobId: "ocr-job-1",
        version: 8,
        rawText: "newer review from another admin",
        rows: [
          {
            id: "row-1",
            sourceText: "PRADAYS Image Deck",
            confidence: 0.91,
            box: [
              [20, 32],
              [264, 32],
              [264, 74],
              [20, 74],
            ],
            productName: "Server 최신값",
            brand: "PRADAYS",
            option: "8.5\u2033",
            quantity: "12",
          },
        ],
      },
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [patchUrl, patchRequest] = fetchImplementation.mock.calls[0];
    const [getUrl, getRequest] = fetchImplementation.mock.calls[1];
    const getHeaders = new Headers(getRequest?.headers);

    expect(patchUrl).toBe("https://api.example.com/prod/admin/ocr/jobs/ocr-job-1");
    expect(patchRequest).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(patchRequest?.body)).rawText).toBe("local stale raw text");
    expect(getUrl).toBe("https://api.example.com/prod/admin/ocr/jobs/ocr-job-1");
    expect(getRequest).toMatchObject({ method: "GET" });
    expect(getHeaders.get("authorization")).toBe("Bearer cognito-admin-access-token");
  });
});
