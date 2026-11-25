import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalOcrRelay } from "../scripts/local-ocr-relay";
import {
  issuer,
  clientId,
  origin,
  canonical,
  tableProviderFixture,
  servers,
  fixture,
} from "./local-ocr-relay-fixtures";

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("local OCR relay boundary and canonical reviews", () => {
  it.each([0, -1, 130001, 1.5, NaN, Infinity, "12000", false])(
    "rejects invalid local timeout override %s",
    (providerTimeoutMs) => {
      expect(() =>
        createLocalOcrRelay({
          origin,
          port: 18011,
          issuer,
          clientId,
          providerUrl: "http://127.0.0.1:8010",
          sharedSecret: "test",
          providerTimeoutMs: providerTimeoutMs as number,
        }),
      ).toThrow("LOCAL_OCR_CONFIGURATION_INVALID");
    },
  );

  it("keeps a bounded override and blocks another OCR while provider work is pending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { request, image } = await fixture({
      providerTimeoutMs: 130000,
      fetcher: async () => {
        entered();
        await gate;
        return Response.json(canonical);
      },
    });
    const first = request(undefined, image);
    await started;
    expect((await request(undefined, image)).status).toBe(429);
    release();
    expect((await first).status).toBe(201);
    expect((await request(undefined, image)).status).toBe(201);
  });

  it("returns a safe bounded provider timeout without storing a review", async () => {
    const { request, image } = await fixture({
      providerTimeoutMs: 25,
      fetcher: async () => new Promise<Response>(() => {}),
    });
    const response = await request(undefined, image);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "OCR_PROVIDER_REQUEST_FAILED" });
  });

  it.each([
    [false, 130000, 130000],
    [true, undefined, 12000],
    [true, 12000, 12000],
    [true, 130000, 115000],
  ] as const)(
    "caps only demo provider deadline (demo %s, override %s)",
    async (demoEnabled, providerTimeoutMs, expected) => {
      const { request, image } = await fixture({ demoEnabled, providerTimeoutMs });
      const timeout = vi.spyOn(globalThis, "setTimeout");
      try {
        expect((await request(undefined, image)).status).toBe(201);
        expect(timeout).toHaveBeenCalledWith(expect.any(Function), expected);
        if (demoEnabled)
          expect(timeout).not.toHaveBeenCalledWith(expect.any(Function), 130000);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("uses the private provider contract, then preserves rawText and metadata on PATCH/GET", async () => {
    const { request, image, calls } = await fixture();
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job.rows[0].sourceText).toBe("테스트 입고");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].body))).toEqual({
      file: image.imageBase64,
      fileType: 1,
      visualize: false,
    });
    expect(calls[0].headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-provider-secret",
    });
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const patch = await request(
      path,
      {
        version: 1,
        rawText: " \n수정됨\n ",
        rows: [
          {
            ...job.rows[0],
            sourceText: "",
            productName: "수정 상품",
            quantity: "2",
            confidence: 0,
            box: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      },
      "PATCH",
    );
    expect(patch.status).toBe(200);
    const saved = (await patch.json()).job;
    expect(saved.version).toBe(2);
    expect(saved.rawText).toBe(" \n수정됨\n ");
    expect(saved.rows[0].sourceText).toBe("");
    expect(saved.rows[0].confidence).toBe(0.97);
    expect(saved.rows[0].box).toEqual([
      [1, 2],
      [30, 2],
      [30, 40],
      [1, 40],
    ]);
    expect((await (await request(path)).json()).job).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain("imageBase64");
    expect(JSON.stringify(saved)).not.toContain("test-provider-secret");
    expect(JSON.stringify(saved)).not.toContain("expiresAt");
    expect(
      (await request(path, { version: 1, rows: saved.rows }, "PATCH")).status,
    ).toBe(409);
    const blank = await request(
      path,
      { version: 2, rawText: "", rows: saved.rows },
      "PATCH",
    );
    expect((await blank.json()).job.rawText).toBe("");
  });

  it("groups table products and preserves editable fields, original metadata, and conflicts", async () => {
    const { envelope, originalRows } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    const expectedRows = [
      {
        ...originalRows[5],
        sourceText: "23 | Fixture Bearings | Set of 8 | Juniper Co",
        productName: "Fixture Bearings",
        brand: "Juniper Co",
        option: "Set of 8",
        quantity: "23",
      },
      {
        ...originalRows[9],
        sourceText: "6 | Fixture Griptape | 9 inch | Echo Goods",
        productName: "Fixture Griptape",
        brand: "Echo Goods",
        option: "9 inch",
        quantity: "6",
      },
    ];
    expect(job.rows).toEqual(expectedRows);
    expect(job.rawText).toBe(originalRows.map((row) => row.sourceText).join("\n"));
    expect(job.version).toBe(1);
    expect(job).not.toHaveProperty("sourceRows");

    const editedRows = expectedRows.map((row, index) => ({
      ...row,
      ...(index === 1
        ? { productName: "Fixture Griptape revised", quantity: "9" }
        : {}),
    }));
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const patched = await request(
      path,
      {
        version: 1,
        rows: editedRows.map((row) => ({
          ...row,
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
        sourceRows: [{ id: "forged", sourceText: "replaced originals" }],
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    const saved = (await patched.json()).job;
    expect(saved.jobId).toBe(job.jobId);
    expect(saved.version).toBe(2);
    expect(saved.rawText).toBe(job.rawText);
    expect(saved.rows).toEqual(editedRows);
    expect(saved).not.toHaveProperty("sourceRows");
    const loaded = await request(path);
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).job).toEqual(saved);
    const stale = await request(path, { version: 1, rows: editedRows }, "PATCH");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "OCR_JOB_VERSION_CONFLICT" });
    expect((await (await request(path)).json()).job).toEqual(saved);
  });

  it("retains every token and metadata when a table header is missing", async () => {
    const { envelope, originalRows } = tableProviderFixture(true);
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job.rows).toEqual(
      originalRows.map((row) => ({
        ...row,
        productName: "",
        brand: "",
        option: "",
        quantity: "",
      })),
    );
    expect(job.rawText).toBe(originalRows.map((row) => row.sourceText).join("\n"));
    expect(job).not.toHaveProperty("sourceRows");
    const loaded = await request(`/admin/ocr/jobs/${job.jobId}`);
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).job).toEqual(job);
  });
});
