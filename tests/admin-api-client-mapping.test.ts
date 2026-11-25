import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiRequestError } from "@/lib/commerce/admin-api-client";
import { AdminApiResponseError } from "@/lib/commerce/admin-api-client-errors";
import { getOcrRequestErrorMessage } from "@/lib/commerce/admin-api-client-ocr-errors";
import type { OcrColumnMapping } from "@/lib/admin-ui/types";
import { createClient, REVIEW_ROW } from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
