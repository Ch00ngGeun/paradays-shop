// 역할: 관리자 API 클라이언트가 Cognito 토큰을 사용하고, 민감한 OCR 입력을 브라우저에서 먼저 검증하는지 확인합니다.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiRequestError,
  AdminApiResponseError,
  AdminOcrInputError,
  createAdminApiClient,
  getOcrRequestErrorMessage,
  isLocalOcrDevelopmentMode,
} from "@/lib/commerce/admin-api-client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import { getCheckoutApiConfig } from "@/lib/commerce/checkout-api-client";
import type { AdminOcrReviewRow } from "@/lib/admin-ui/types";

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

describe("createAdminApiClient", () => {
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
