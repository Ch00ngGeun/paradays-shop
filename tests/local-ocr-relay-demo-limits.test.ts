import { afterEach, describe, expect, it, vi } from "vitest";
import {
  demoOrigin,
  jwk,
  tableProviderFixture,
  servers,
  jwt,
  fixture,
  pendingUpload,
} from "./local-ocr-relay-fixtures";

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("local OCR relay boundary and canonical reviews", () => {
  it("bounds demo requests before a stalled JWKS lookup completes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { request, image, calls, server } = await fixture({
      demoEnabled: true,
      jwksLoader: async () => {
        await gate;
        return { keys: [jwk] };
      },
    });
    let started = 0;
    const fourStarted = new Promise<void>((resolve) => {
      server.on("request", () => {
        if (++started === 4) resolve();
      });
    });
    const waiting = Array.from({ length: 4 }, () => request(undefined, image));
    try {
      await fourStarted;
      const overflow = await request(undefined, image);
      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toEqual({ code: "LOCAL_OCR_LIMIT_REACHED" });
      expect(calls).toHaveLength(0);
    } finally {
      release();
    }
    const responses = await Promise.all(waiting);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
    expect((await request(undefined, image)).status).toBe(201);
  });

  it("reserves demo OCR before upload, times out a stalled body and releases all slots", async () => {
    const { request, image, calls, port, server } = await fixture({
      demoEnabled: true,
    });
    const started = new Promise<void>((resolve) => {
      server.once("request", () => resolve());
    });
    const first = pendingUpload(port);
    try {
      await started;
      // The completed GET guarantees the first handler has passed its auth microtask.
      expect((await request("/admin/ocr/jobs/ocr_missing")).status).toBe(404);
      const overflow = pendingUpload(port);
      try {
        expect(await overflow.response).toEqual({
          status: 429,
          body: { code: "OCR_PROVIDER_BUSY" },
        });
        expect(calls).toHaveLength(0);
      } finally {
        overflow.upload.destroy();
      }
      expect(await first.response).toEqual({
        status: 408,
        body: { code: "LOCAL_OCR_BODY_TIMEOUT" },
      });
      expect(calls).toHaveLength(0);
      expect((await request(undefined, image)).status).toBe(201);
      expect(calls).toHaveLength(1);
    } finally {
      first.upload.destroy();
    }
  }, 10000);

  it("caps pending demo PATCH bodies before allocation and permits GET without reading a body", async () => {
    const { request, image, port, server } = await fixture({ demoEnabled: true });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    let count = 0;
    const started = new Promise<void>((resolve) => {
      server.on("request", () => {
        if (++count === 2) resolve();
      });
    });
    const pending = [
      pendingUpload(port, path, jwt(), "PATCH"),
      pendingUpload(port, path, jwt(), "PATCH"),
    ];
    for (const entry of pending) void entry.response.catch(() => {});
    try {
      await started;
      expect((await request(path)).status).toBe(200);
      const overflow = pendingUpload(port, path, jwt(), "PATCH");
      try {
        expect(await overflow.response).toEqual({
          status: 429,
          body: { code: "LOCAL_OCR_LIMIT_REACHED" },
        });
      } finally {
        overflow.upload.destroy();
      }
      expect((await (await request(path)).json()).job).toEqual(job);
    } finally {
      for (const entry of pending) entry.upload.destroy();
    }
  });

  it("limits all authenticated demo GET/PATCH requests, not only OCR POST", async () => {
    let now = Date.now();
    const { request, image } = await fixture({ demoEnabled: true, now: () => now });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    for (let index = 0; index < 119; index++)
      expect((await request(path)).status).toBe(200);
    for (const [body, method] of [
      [undefined, "GET"],
      [{ version: 1, rows: job.rows }, "PATCH"],
    ] as const) {
      const limited = await request(path, body, method);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ code: "LOCAL_OCR_LIMIT_REACHED" });
    }
    now += 60000;
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it("shares a bounded cheap demo budget for health and preflight without authentication", async () => {
    let now = Date.now();
    const { request, calls } = await fixture({ demoEnabled: true, now: () => now });
    for (let index = 0; index < 240; index++) {
      const response =
        index % 2 === 0
          ? await request("/healthz", undefined, "GET", "")
          : await request(undefined, undefined, "OPTIONS", "", { origin: demoOrigin });
      expect(response.status).toBe(index % 2 === 0 ? 200 : 204);
    }
    expect((await request("/healthz", undefined, "GET", "")).status).toBe(429);
    now += 60000;
    expect(
      (await request(undefined, undefined, "OPTIONS", "", { origin: demoOrigin }))
        .status,
    ).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("enforces the existing 30 OCR/minute limit before reading a demo upload", async () => {
    let now = Date.now();
    const { request, image, calls, port } = await fixture({
      demoEnabled: true,
      now: () => now,
    });
    for (let index = 0; index < 30; index++)
      expect((await request(undefined, image)).status).toBe(201);
    const pending = pendingUpload(port);
    try {
      expect(await pending.response).toEqual({
        status: 429,
        body: { code: "LOCAL_OCR_LIMIT_REACHED" },
      });
      expect(calls).toHaveLength(30);
      now += 60000;
      expect((await request(undefined, image)).status).toBe(201);
    } finally {
      pending.upload.destroy();
    }
  });

  it("enforces the existing 100-job cap before reading a demo upload", async () => {
    let now = Date.now();
    const { request, image, calls, port } = await fixture({
      demoEnabled: true,
      now: () => now,
    });
    for (let index = 0; index < 100; index++) {
      if (index > 0 && index % 25 === 0) now += 60000;
      expect((await request(undefined, image)).status).toBe(201);
    }
    const pending = pendingUpload(port);
    try {
      expect(await pending.response).toEqual({
        status: 429,
        body: { code: "LOCAL_OCR_LIMIT_REACHED" },
      });
      expect(calls).toHaveLength(100);
    } finally {
      pending.upload.destroy();
    }
  });
  it("previews drag regions read-only and persists canonical sources across apply/review/GET", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = (await (await request(undefined, image)).json()).job;
    const path = `/admin/ocr/jobs/${created.jobId}`;
    const mapping = {
      schemaVersion: 2,
      parserVersion: 1,
      kind: "regions",
      image: { width: 1000, height: 1000 },
      firstRow: {
        productName: { left: 0.17, top: 0.14, right: 0.41, bottom: 0.18 },
        brand: { left: 0.69, top: 0.14, right: 0.84, bottom: 0.18 },
        option: { left: 0.47, top: 0.14, right: 0.64, bottom: 0.18 },
        quantity: { left: 0.02, top: 0.14, right: 0.065, bottom: 0.18 },
      },
      tableBottom: 0.28,
      secondRowY: null,
      quantityConfirmed: true,
    };
    const previewResponse = await request(
      path,
      { version: 1, mapping, preview: true },
      "PATCH",
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()).preview;
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({
      id: "ocr_6",
      productName: "Fixture Bearings",
      quantity: "23",
    });
    expect(preview.analysis.region).toMatchObject({
      sourceTokenCount: 13,
      includedTokenCount: 8,
      excludedTokenCount: 5,
    });
    expect((await (await request(path)).json()).job).toEqual(created);
    const appliedResponse = await request(path, { version: 1, mapping }, "PATCH");
    expect(appliedResponse.status).toBe(200);
    const applied = (await appliedResponse.json()).job;
    expect(applied.version).toBe(2);
    expect(applied.rows).toEqual(preview.rows);
    const reviewedResponse = await request(
      path,
      {
        version: 2,
        rows: applied.rows.map((row: Record<string, unknown>) => ({
          ...row,
          productName: "Edited",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
      },
      "PATCH",
    );
    const reviewed = (await reviewedResponse.json()).job;
    expect(reviewed.rows[0].confidence).toBe(applied.rows[0].confidence);
    expect(reviewed.rows[0].box).toEqual(applied.rows[0].box);
    expect(reviewed.analysis.mapping).toEqual(mapping);
    expect((await (await request(path)).json()).job).toEqual(reviewed);
    expect((await request(path, { version: 1, mapping }, "PATCH")).status).toBe(409);
    expect(
      (
        await request(
          path,
          { version: 3, mapping: { ...mapping, quantityConfirmed: false } },
          "PATCH",
        )
      ).status,
    ).toBe(400);
    const again = (
      await (
        await request(path, { version: 3, mapping, preview: true }, "PATCH")
      ).json()
    ).preview;
    expect(again.rows).toEqual(preview.rows);
  });
});
