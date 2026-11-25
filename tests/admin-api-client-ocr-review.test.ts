import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminOcrInputError } from "@/lib/commerce/admin-api-client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import { createClient } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createAdminApiClient", () => {
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
