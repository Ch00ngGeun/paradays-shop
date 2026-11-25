// 역할: 관리자 API 클라이언트가 Cognito 토큰을 사용하고, 민감한 OCR 입력을 브라우저에서 먼저 검증하는지 확인합니다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import {
  AdminApiResponseError,
  AdminOcrDemoConnectionError,
} from "@/lib/commerce/admin-api-client-errors";
import { getOcrRequestErrorMessage } from "@/lib/commerce/admin-api-client-ocr-errors";
import { createClient, REVIEW_ROW, saveClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
});
