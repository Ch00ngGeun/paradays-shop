import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  origin,
  tableProviderFixture,
  servers,
  jwt,
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
  it("previews without mutation and reapplies mapping from original tokens after ordinary edits", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    const { job } = await created.json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const mapping = {
      schemaVersion: 1,
      headerRow: 1,
      columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
    };
    const previewResponse = await request(
      path,
      {
        version: 1,
        mapping,
        preview: true,
      },
      "PATCH",
    );
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody).not.toHaveProperty("job");
    const preview = previewBody.preview;
    expect(preview.version).toBe(1);
    expect(preview.analysis.mode).toBe("table");
    expect(preview.rows[0].productName).toBe("Fixture Bearings");
    expect(preview).not.toHaveProperty("sourceRows");
    expect((await (await request(path)).json()).job).toEqual(job);

    const applyResponse = await request(path, { version: 1, mapping }, "PATCH");
    expect(applyResponse.status).toBe(200);
    const applied = (await applyResponse.json()).job;
    expect(applied.version).toBe(2);
    expect(applied.rows).toEqual(preview.rows);
    expect(applied.analysis.mapping).toEqual(mapping);
    expect(applied).not.toHaveProperty("sourceRows");
    const edited = await request(
      path,
      {
        version: 2,
        rawText: "operator revised text",
        rows: applied.rows.map((row: Record<string, unknown>) => ({
          ...row,
          sourceText: "operator revised source",
          productName: "operator revised product",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
        sourceRows: [{ id: "forged", sourceText: "fake source" }],
      },
      "PATCH",
    );
    expect(edited.status).toBe(200);
    const reviewed = (await edited.json()).job;
    expect(reviewed.version).toBe(3);
    expect(reviewed.analysis).toEqual(applied.analysis);
    applied.rows.forEach((row: Record<string, unknown>, index: number) => {
      expect(reviewed.rows[index].confidence).toBe(row.confidence);
      expect(reviewed.rows[index].box).toEqual(row.box);
    });
    const swapped = {
      ...mapping,
      columns: { productName: 3, brand: 1, option: 2, quantity: 0 },
    };
    const remappedResponse = await request(
      path,
      {
        version: 3,
        mapping: swapped,
      },
      "PATCH",
    );
    expect(remappedResponse.status).toBe(200);
    const remapped = (await remappedResponse.json()).job;
    expect(remapped.version).toBe(4);
    expect(remapped.rawText).toBe("operator revised text");
    expect(remapped.rows[0].productName).toBe("Juniper Co");
    expect(remapped.rows[0].brand).toBe("Fixture Bearings");
    expect(remapped.rows.map((row: { id: string }) => row.id)).toEqual(
      applied.rows.map((row: { id: string }) => row.id),
    );
    expect(remapped.rows[0].sourceText).toContain("Fixture Bearings");
    const repeated = await request(
      path,
      {
        version: 4,
        mapping: swapped,
        preview: true,
      },
      "PATCH",
    );
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).preview.rows).toEqual(remapped.rows);
    expect((await (await request(path)).json()).job).toEqual(remapped);
    const stale = await request(path, { version: 3, mapping }, "PATCH");
    expect(stale.status).toBe(409);
    expect((await (await request(path)).json()).job).toEqual(remapped);
  });

  it("rejects malformed, mixed and forged mapping requests without changing the review", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const mapping = {
      schemaVersion: 1,
      headerRow: 1,
      columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
    };
    for (const body of [
      { version: 1, mapping: null },
      { version: 1, mapping: { ...mapping, schemaVersion: 2 } },
      { version: 1, mapping: { ...mapping, headerRow: 500 } },
      { version: 1, mapping: { ...mapping, unexpected: "raw OCR" } },
      {
        version: 1,
        mapping: { ...mapping, columns: { ...mapping.columns, brand: 1 } },
      },
      { version: 1, mapping, preview: false },
      { version: 1, mapping, rows: job.rows },
      { version: 1, mapping, rawText: "forged" },
      { version: 1, mapping, sourceRows: [] },
    ]) {
      const result = await request(path, body, "PATCH");
      expect(result.status).toBe(400);
      expect((await result.json()).code).toBe("OCR_JOB_MAPPING_INVALID");
    }
    const outOfRange = await request(
      path,
      {
        version: 1,
        mapping: { ...mapping, columns: { ...mapping.columns, quantity: 19 } },
      },
      "PATCH",
    );
    expect(outOfRange.status).toBe(400);
    expect((await outOfRange.json()).code).toBe("OCR_JOB_MAPPING_UNUSABLE");
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it("returns an explicit mapping error for an unclassified OCR source", async () => {
    const { request, image } = await fixture();
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const result = await request(
      path,
      {
        version: 1,
        mapping: {
          schemaVersion: 1,
          headerRow: 0,
          columns: { productName: 0, brand: null, option: null, quantity: null },
        },
        preview: true,
      },
      "PATCH",
    );
    expect(result.status).toBe(400);
    const error = await result.json();
    expect(error.code).toBe("OCR_JOB_MAPPING_UNUSABLE");
    expect(error.message).toBeTruthy();
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it.each([
    ["expired", { exp: 1 }, {}, 401],
    ["wrong issuer", { iss: "https://wrong.example" }, {}, 401],
    ["wrong client", { client_id: "anotherclient" }, {}, 401],
    ["ID token", { token_use: "id" }, {}, 401],
    ["future nbf", { nbf: 4102444800 }, {}, 401],
    ["empty subject", { sub: "" }, {}, 401],
    ["missing subject", { sub: undefined }, {}, 401],
    ["non-admin", { "cognito:groups": ["support"] }, {}, 403],
    ["no group", { "cognito:groups": undefined }, {}, 403],
    ["unknown key", {}, { kid: "unknown" }, 401],
    ["none algorithm", {}, { alg: "none" }, 401],
  ])("rejects %s before provider calls", async (_name, claims, header, status) => {
    const { request, image, calls } = await fixture();
    expect((await request(undefined, image, "POST", jwt(claims, header))).status).toBe(
      status,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects forged signatures, missing bearer, remote Origin and rebinding Host", async () => {
    const { request, image, calls, port } = await fixture();
    const token = jwt();
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    parts[1] = Buffer.from(JSON.stringify({ ...payload, sub: "forged" })).toString(
      "base64url",
    );
    expect((await request(undefined, image, "POST", parts.join("."))).status).toBe(401);
    expect(
      (await request(undefined, image, "POST", token, { authorization: "" })).status,
    ).toBe(401);
    expect(
      (
        await request(undefined, image, "POST", token, {
          origin: "https://remote.example",
        })
      ).status,
    ).toBe(403);
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/admin/ocr/jobs",
          method: "POST",
          headers: {
            host: "remote.example",
            origin,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(image));
    });
    expect(rebindingStatus).toBe(403);
    expect(
      (await request(undefined, image, "POST", token, { origin: "" })).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("expires reviews after seven days and loses them on a new server", async () => {
    let now = Date.now();
    const first = await fixture({ now: () => now });
    const { job } = await (await first.request(undefined, first.image)).json();
    const second = await fixture();
    expect((await second.request(`/admin/ocr/jobs/${job.jobId}`)).status).toBe(404);
    now += 7 * 24 * 60 * 60 * 1000;
    expect((await first.request(`/admin/ocr/jobs/${job.jobId}`)).status).toBe(404);
  });

  it.each([false, true])(
    "rejects image errors and malformed review rows without overwriting canonical state (demo %s)",
    async (demoEnabled) => {
      const { request, image, calls } = await fixture({ demoEnabled });
      expect(
        (await request(undefined, { ...image, imageBase64: "invalid" })).status,
      ).toBe(400);
      expect(
        (
          await request(undefined, {
            ...image,
            imageBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
          })
        ).status,
      ).toBe(413);
      expect(calls).toHaveLength(0);
      const { job } = await (await request(undefined, image)).json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      expect(
        (await request(path, { version: 1, rawText: "\0", rows: job.rows }, "PATCH"))
          .status,
      ).toBe(400);
      expect(
        (await request(path, { version: 1, rows: [job.rows[0], job.rows[0]] }, "PATCH"))
          .status,
      ).toBe(400);
      expect(
        (
          await request(
            path,
            { version: 1, rows: [{ ...job.rows[0], quantity: "-1" }] },
            "PATCH",
          )
        ).status,
      ).toBe(400);
      expect((await (await request(path)).json()).job.version).toBe(1);
    },
  );

  it.each([false, true])(
    "caps provider response bytes and rejects invalid provider envelopes (demo %s)",
    async (demoEnabled) => {
      const huge = await fixture({
        demoEnabled,
        fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      });
      expect((await huge.request(undefined, huge.image)).status).toBe(502);
      const invalid = await fixture({
        demoEnabled,
        fetcher: async () => Response.json({ unrelated: true }),
      });
      expect(
        (await (await invalid.request(undefined, invalid.image)).json()).code,
      ).toBe("OCR_PROVIDER_RESPONSE_INVALID");
    },
  );
});
