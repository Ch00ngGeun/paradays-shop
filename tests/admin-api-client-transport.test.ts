// 역할: 개발용 로컬 OCR 전송과 고정 HTTPS OCR 시연 전송의 활성화 조건·인증·경로를 검증함.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminApiRequestError,
  createAdminApiClient,
} from "@/lib/commerce/admin-api-client";
import {
  AdminApiResponseError,
  AdminOcrDemoConnectionError,
} from "@/lib/commerce/admin-api-client-errors";
import { getOcrRequestErrorMessage } from "@/lib/commerce/admin-api-client-ocr-errors";
import {
  isLocalOcrDevelopmentMode,
  isRemoteOcrDemoMode,
} from "@/lib/commerce/admin-api-client-environment";
import type { OcrColumnMapping } from "@/lib/admin-ui/types";
import {
  apiConfig,
  createClient,
  REVIEW_ROW,
  saveClient,
} from "./admin-api-client-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
