import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalOcrRelay } from "../scripts/local-ocr-relay";
import {
  issuer,
  clientId,
  origin,
  demoOrigin,
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
  it.each([undefined, false])(
    "keeps Firebase disabled without strict opt-in %s",
    async (demoEnabled) => {
      const { request, image, calls } = await fixture({ demoEnabled });
      const response = await request(undefined, image, "POST", jwt(), {
        origin: demoOrigin,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "LOCAL_OCR_ORIGIN_REQUIRED" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  it.each([null, "true", "false", 1, 0, {}, []])(
    "rejects malformed demo opt-in %s",
    (demoEnabled) => {
      expect(() =>
        createLocalOcrRelay({
          origin,
          port: 18011,
          issuer,
          clientId,
          providerUrl: "http://127.0.0.1:8010",
          sharedSecret: "test",
          demoEnabled: demoEnabled as boolean,
        }),
      ).toThrow("LOCAL_OCR_CONFIGURATION_INVALID");
    },
  );

  it("adds only the Firebase Origin and exact preflight responses while preserving local access", async () => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    for (const allowed of [origin, demoOrigin]) {
      const preflight = await request(undefined, undefined, "OPTIONS", "", {
        origin: allowed,
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(preflight.headers.get("vary")).toBe("Origin");
      expect(preflight.headers.get("access-control-allow-methods")).toBe(
        "GET,POST,PATCH,OPTIONS",
      );
      const created = await request(undefined, image, "POST", jwt(), {
        origin: allowed,
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("access-control-allow-origin")).toBe(allowed);
      const { job } = await created.json();
      const loaded = await request(
        `/admin/ocr/jobs/${job.jobId}`,
        undefined,
        "GET",
        jwt(),
        { origin: allowed },
      );
      expect(loaded.status).toBe(200);
      expect((await loaded.json()).job).toEqual(job);
    }
    expect(calls).toHaveLength(2);
  });

  it.each([
    "http://paradays.web.app",
    "https://paradays.web.app/",
    "https://paradays.web.app:443",
    "https://paradays.web.app.evil.example",
    "https://evil.paradays.web.app",
    "https://paradays.firebaseapp.com",
    "https://remote.example",
    "null",
    "",
  ])("rejects non-exact demo Origin %s including preflight", async (disallowed) => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    for (const [body, method] of [
      [image, "POST"],
      [undefined, "OPTIONS"],
    ] as const) {
      const response = await request(undefined, body, method, jwt(), {
        origin: disallowed,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "LOCAL_OCR_ORIGIN_REQUIRED" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("preserves production and local-origin configuration guards even with demo enabled", () => {
    const options = {
      origin,
      port: 18011,
      issuer,
      clientId,
      providerUrl: "http://127.0.0.1:8010",
      sharedSecret: "test",
      demoEnabled: true,
    };
    expect(() => createLocalOcrRelay({ ...options, origin: demoOrigin })).toThrow(
      "LOCAL_OCR_CONFIGURATION_INVALID",
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createLocalOcrRelay(options)).toThrow(
      "LOCAL_OCR_CONFIGURATION_INVALID",
    );
  });

  it("does not trust a tunnel or forwarded Host in demo mode", async () => {
    const { port, calls } = await fixture({ demoEnabled: true });
    const pending = pendingUpload(port, undefined, jwt(), "POST", {
      host: "public-tunnel.example",
      "x-forwarded-host": `127.0.0.1:${port}`,
    });
    try {
      expect(await pending.response).toEqual({
        status: 403,
        body: { code: "LOCAL_OCR_ORIGIN_REQUIRED" },
      });
      expect(calls).toHaveLength(0);
    } finally {
      pending.upload.destroy();
    }
  });

  it("does not use an ID token or decoded groups to bypass signed access-token admin authorization", async () => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    const response = await request(
      undefined,
      image,
      "POST",
      jwt({ "cognito:groups": undefined }),
      {
        origin: demoOrigin,
        "x-local-id-token": jwt({ token_use: "id", aud: clientId }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "ADMIN_ROLE_REQUIRED" });
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])(
    "isolates signed admin subjects for GET, review, mapping, preview and stale versions (demo %s)",
    async (demoEnabled) => {
      const { envelope } = tableProviderFixture();
      const { request, image } = await fixture({
        demoEnabled,
        fetcher: async () => Response.json(envelope),
      });
      const headers = { origin: demoEnabled ? demoOrigin : origin };
      const adminA = jwt({ sub: "admin-A" });
      const adminB = jwt({ sub: "admin-B" });
      const createdResponse = await request(undefined, image, "POST", adminA, headers);
      const { job } = await createdResponse.json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      const mapping = {
        schemaVersion: 1,
        headerRow: 1,
        columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
      };
      const missing = await request(
        "/admin/ocr/jobs/ocr_missing",
        undefined,
        "GET",
        adminB,
        headers,
      );
      const notFound = await missing.json();
      expect(notFound).toEqual({ code: "OCR_JOB_NOT_FOUND" });
      for (const [body, method] of [
        [undefined, "GET"],
        [undefined, "PATCH"],
        [{ version: 1, rows: job.rows }, "PATCH"],
        [{ version: 1, mapping, preview: true }, "PATCH"],
        [{ version: 1, mapping }, "PATCH"],
        [{ version: 999, rows: job.rows }, "PATCH"],
        [{ version: 0, mapping: null }, "PATCH"],
      ] as const) {
        const denied = await request(path, body, method, adminB, headers);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual(notFound);
      }
      const previewResponse = await request(
        path,
        { version: 1, mapping, preview: true },
        "PATCH",
        adminA,
        headers,
      );
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()).preview;
      const appliedResponse = await request(
        path,
        { version: 1, mapping },
        "PATCH",
        adminA,
        headers,
      );
      expect(appliedResponse.status).toBe(200);
      const applied = (await appliedResponse.json()).job;
      expect(applied.version).toBe(2);
      expect(applied.rows).toEqual(preview.rows);
      const reviewedResponse = await request(
        path,
        { version: 2, rows: applied.rows, ownerSub: "admin-B" },
        "PATCH",
        adminA,
        headers,
      );
      const reviewed = (await reviewedResponse.json()).job;
      expect(reviewed.version).toBe(3);
      expect(
        (await request(path, { version: 1, mapping }, "PATCH", adminA, headers)).status,
      ).toBe(409);
      const deniedStale = await request(
        path,
        { version: 1, mapping },
        "PATCH",
        adminB,
        headers,
      );
      expect(deniedStale.status).toBe(404);
      expect(await deniedStale.json()).toEqual(notFound);
      expect(
        (await (await request(path, undefined, "GET", adminA, headers)).json()).job,
      ).toEqual(reviewed);
      for (const publicValue of [job, preview, applied, reviewed]) {
        expect(publicValue).not.toHaveProperty("ownerSub");
        expect(publicValue).not.toHaveProperty("sourceRows");
        expect(JSON.stringify(publicValue)).not.toContain("admin-A");
        expect(JSON.stringify(publicValue)).not.toContain("admin-B");
        expect(JSON.stringify(publicValue)).not.toContain("test-provider-secret");
      }
    },
  );

  it.each([false, true])(
    "rechecks latest canonical version after a held same-owner PATCH body (demo %s)",
    async (demoEnabled) => {
      const { request, image, port, server } = await fixture({ demoEnabled });
      const token = jwt({ sub: "same-owner" });
      const headers = { origin: demoEnabled ? demoOrigin : origin };
      const { job } = await (
        await request(undefined, image, "POST", token, headers)
      ).json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      const slowBody = JSON.stringify({
        version: 1,
        rawText: "Slow obsolete raw text",
        rows: job.rows.map((row: Record<string, unknown>) => ({
          ...row,
          sourceText: "Slow obsolete source",
          productName: "Slow obsolete product",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
      });
      const started = new Promise<void>((resolve) => {
        server.once("request", () => resolve());
      });
      const held = pendingUpload(port, path, token, "PATCH", {
        ...headers,
        "content-length": String(Buffer.byteLength(slowBody)),
      });
      void held.response.catch(() => {});
      try {
        await started;
        expect((await request(path, undefined, "GET", token, headers)).status).toBe(
          200,
        );
        const fast = await request(
          path,
          {
            version: 1,
            rawText: "Fast canonical raw text",
            rows: job.rows.map((row: Record<string, unknown>) => ({
              ...row,
              sourceText: "Fast canonical source",
              productName: "Fast canonical product",
              confidence: 0,
              box: [
                [777, 777],
                [888, 888],
              ],
            })),
          },
          "PATCH",
          token,
          headers,
        );
        expect(fast.status).toBe(200);
        const saved = (await fast.json()).job;
        expect(saved.version).toBe(2);
        expect(saved.rows[0].confidence).toBe(job.rows[0].confidence);
        expect(saved.rows[0].box).toEqual(job.rows[0].box);
        held.upload.end(slowBody.slice(1));
        expect(await held.response).toEqual({
          status: 409,
          body: { code: "OCR_JOB_VERSION_CONFLICT" },
        });
        expect(
          (await (await request(path, undefined, "GET", token, headers)).json()).job,
        ).toEqual(saved);
      } finally {
        held.upload.destroy();
      }
    },
  );
});
