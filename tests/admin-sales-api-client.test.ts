import { describe, expect, it, vi } from "vitest";
import {
  AdminSalesError,
  createAdminSalesApiClient,
  parseSalesDay,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
const day = "2026-10-15";
const entry = {
  businessDay: day,
  recordType: "SALE",
  entryId: "sale_001",
  version: 1,
  status: "DRAFT",
  kind: "SALE",
  soldAt: "2026-10-15T01:00:00Z",
  method: "CARD",
  reference: "CARD-001",
  amount: 100,
  memo: "",
  lines: [],
  createdAt: "2026-10-15T01:00:00Z",
  updatedAt: "2026-10-15T01:00:00Z",
};
const totals = {
  card: 0,
  cash: 0,
  offlineRefunds: 0,
  offlineNet: 0,
  onlineGross: 0,
  onlineRefunds: 0,
  onlineNet: 0,
  combinedNet: 0,
};
const report = {
  businessDay: day,
  timezone: "Asia/Seoul",
  version: 1,
  status: "OPEN",
  asOf: "2026-10-15T01:00:00Z",
  entries: [entry],
  onlineEvents: [],
  totals,
  warnings: ["UNPOSTED_SALES"],
  onlineFingerprint: "a".repeat(64),
  snapshots: [],
  history: [],
  complete: true,
};
const save: SalesCommand = {
  action: "save",
  entryId: "sale_001",
  expectedVersion: 0,
  soldAt: entry.soldAt,
  method: "CARD",
  reference: "CARD-001",
  amount: 100,
  memo: "",
  lines: [],
};
function client(fetcher: typeof fetch, getAccessToken = () => "mock-admin") {
  return createAdminSalesApiClient({
    config: { apiBaseUrl: "https://api.example.test/prod/" },
    authorizationTokenProvider: { getAccessToken },
    fetchImplementation: fetcher,
  });
}
describe("administrator sales transport", () => {
  it("waits beyond the server's 24-second work budget without weakening uncertain-write handling", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetcher = vi.fn(async (_: unknown, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        return new Response(
          JSON.stringify({ code: "SALES_REQUEST_DEADLINE_EXCEEDED" }),
          {
            status: 503,
          },
        );
      });
      const error = await client(fetcher)
        .operate(day, save)
        .catch((e) => e);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(27_000);
      expect(error).toBeInstanceOf(AdminSalesError);
      expect(error.status).toBe(503);
      expect(error.resultUncertain).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  it("requires authentication and uses only the dated ledger endpoint", async () => {
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.example.test/prod/admin/sales/${day}`);
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer mock-admin" });
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ report }));
    });
    expect(await client(fetcher).getDay(day)).toMatchObject(report);
    await expect(client(fetcher, () => "").getDay(day)).rejects.toThrow(
      "ADMIN_LOGIN_REQUIRED",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves unmatched drafts without inventing product or stock fields", async () => {
    const fetcher = vi.fn(async (_: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual(save);
      return new Response(
        JSON.stringify({ entry: { ...entry, privateAudit: "omit" } }),
      );
    });
    expect(await client(fetcher).operate(day, save)).toEqual({ entry });
  });
  it("rejects invalid dates, synthetic identities, extra fields and unchecked commands before auth/network", async () => {
    const fetcher = vi.fn(),
      token = vi.fn(() => "mock");
    const api = client(fetcher, token);
    await expect(api.getDay("2026-02-30")).rejects.toThrow("SALES_DAY_INVALID");
    for (const bad of [
      { ...save, entryId: "TEST_bad" },
      { ...save, customerCard: "forbidden" },
      {
        action: "post",
        entryId: "sale_001",
        version: 1,
        previewToken: "a".repeat(64),
        confirmed: false,
      },
      { ...save, soldAt: "2026-10-14T14:59:59Z" },
    ])
      await expect(api.operate(day, bad as SalesCommand)).rejects.toThrow(
        "SALES_COMMAND_INVALID",
      );
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("snapshots the entire command before asynchronous authentication", async () => {
    let resolve!: (value: string) => void;
    const token = new Promise<string>((done) => {
      resolve = done;
    });
    const operation = {
      ...save,
      lines: [
        {
          productId: "prd_deck",
          name: "Deck",
          option: "8",
          quantity: 1,
          unitAmount: 100,
        },
      ],
    };
    const fetcher = vi.fn(async (_: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).lines[0].quantity).toBe(1);
      return new Response(JSON.stringify({ entry }));
    });
    const api = createAdminSalesApiClient({
      config: { apiBaseUrl: "https://api.example.test" },
      authorizationTokenProvider: { getAccessToken: () => token },
      fetchImplementation: fetcher,
    });
    const pending = api.operate(day, operation);
    operation.lines[0]!.quantity = 2;
    resolve("mock");
    await pending;
  });
  it("validates complete totals, dates and unique entries and strips unknown server fields", () => {
    expect(parseSalesDay({ ...report, secret: "omit" }, day)).toEqual({
      ...report,
      totals: { ...totals, transfer: 0 },
    });
    for (const bad of [
      { ...report, complete: false },
      { ...report, entries: [entry, entry] },
      { ...report, totals: { ...totals, combinedNet: 1 } },
      { ...report, entries: [{ ...entry, businessDay: "2026-10-14" }] },
      {
        ...report,
        onlineEvents: [
          {
            orderId: "order_001",
            kind: "REFUND",
            amount: 100,
            occurredAt: "2026-10-14T00:00:00Z",
          },
        ],
      },
    ])
      expect(() => parseSalesDay(bad, day)).toThrow("SALES_RESPONSE_INVALID");
  });
  it("sorts offsets by actual sale time, then stable identity", () => {
    const early = {
        ...entry,
        entryId: "sale_early",
        soldAt: "2026-10-15T09:30:00+09:00",
      },
      later = { ...entry, entryId: "sale_later", soldAt: "2026-10-15T01:00:00Z" };
    expect(
      parseSalesDay({ ...report, entries: [later, early] }, day).entries.map(
        (e) => e.entryId,
      ),
    ).toEqual(["sale_early", "sale_later"]);
  });
  it("requires preview identity and coherent stock bounds", async () => {
    const preview = {
      productId: "prd_deck",
      name: "Deck",
      quantity: 5,
      reserved: 1,
      available: 4,
      delta: -1,
      after: 4,
      version: 2,
    };
    const command: SalesCommand = {
      action: "preview",
      entryId: "sale_001",
      version: 1,
    };
    for (const body of [
      {
        preview: [{ ...preview, after: 5 }],
        previewToken: "a".repeat(64),
        entryId: "sale_001",
        version: 1,
      },
      {
        preview: [preview],
        previewToken: "a".repeat(64),
        entryId: "sale_other",
        version: 1,
      },
    ])
      await expect(
        client(vi.fn(async () => new Response(JSON.stringify(body)))).operate(
          day,
          command,
        ),
      ).rejects.toThrow("SALES_RESPONSE_INVALID");
  });
  it("marks network, invalid success and server failures uncertain while rejecting known 4xx definitively", async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new TypeError("network");
      }),
      vi.fn(async () => new Response("{}")),
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "SALES_WRITE_UNCERTAIN" }), {
            status: 503,
          }),
      ),
    ]) {
      const error = await client(fetcher)
        .operate(day, save)
        .catch((e) => e);
      expect(error).toBeInstanceOf(AdminSalesError);
      expect(error.resultUncertain).toBe(true);
    }
    const rejected = await client(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "SALE_VERSION_OR_STATUS_CONFLICT" }), {
            status: 409,
          }),
      ),
    )
      .operate(day, save)
      .catch((e) => e);
    expect(rejected.resultUncertain).toBe(false);
    expect(rejected.status).toBe(409);
  });
  it("accepts signed cash net and validates snapshot reconciliation", () => {
    const reversal = {
      ...entry,
      entryId: "reverse_001",
      method: "CASH",
      kind: "REVERSAL",
      status: "POSTED",
      original: { businessDay: "2026-10-14", entryId: "sale_original" },
      restocked: false,
    };
    const negative = {
      ...totals,
      cash: -100,
      offlineRefunds: 100,
      offlineNet: -100,
      combinedNet: -100,
    };
    expect(
      parseSalesDay(
        { ...report, entries: [reversal], totals: negative, warnings: [] },
        day,
      ).totals.cash,
    ).toBe(-100);
    expect(() =>
      parseSalesDay(
        {
          ...report,
          status: "CLOSED",
          snapshots: [
            {
              snapshotId: "close_001",
              closedAt: entry.soldAt,
              version: 1,
              totals,
              onlineFingerprint: "a".repeat(64),
              cashComparedAmount: 1,
            },
          ],
        },
        day,
      ),
    ).toThrow();
  });
  it("accepts transfer entries apart from cash and rejects inconsistent transfer totals", () => {
    const transfer = {
      ...entry,
      entryId: "sale_transfer",
      method: "TRANSFER",
      status: "POSTED",
      reference: "TRF-001",
      amount: 300,
    };
    const withTransfer = {
      ...totals,
      transfer: 300,
      offlineNet: 300,
      combinedNet: 300,
    };
    const parsed = parseSalesDay(
      { ...report, entries: [transfer], totals: withTransfer, warnings: [] },
      day,
    );
    expect(parsed.entries[0]!.method).toBe("TRANSFER");
    expect([parsed.totals.card, parsed.totals.cash, parsed.totals.transfer]).toEqual([
      0, 0, 300,
    ]);
    for (const bad of [
      // An older server that omits transfer cannot hide a posted transfer.
      { ...report, entries: [transfer], totals, warnings: [] },
      // A transfer counted as cash is rejected.
      {
        ...report,
        entries: [transfer],
        totals: { ...withTransfer, transfer: 0, cash: 300 },
        warnings: [],
      },
      { ...report, totals: { ...totals, transfer: null } },
      { ...report, totals: { ...totals, transfer: 1.5 } },
      { ...report, totals: { ...totals, transfer: 100 } },
      { ...report, entries: [{ ...entry, method: "BANK" }] },
    ])
      expect(() => parseSalesDay(bad, day)).toThrow("SALES_RESPONSE_INVALID");
  });
  it("reads a legacy snapshot without transfer as 0 but rejects an explicit invalid one", () => {
    const closed = (snapshotTotals: Record<string, unknown>) => ({
      ...report,
      entries: [],
      warnings: [],
      status: "CLOSED",
      snapshots: [
        {
          snapshotId: "close_001",
          closedAt: entry.soldAt,
          version: 1,
          totals: snapshotTotals,
          onlineFingerprint: "a".repeat(64),
          cashComparedAmount: 0,
        },
      ],
    });
    expect(parseSalesDay(closed(totals), day).snapshots[0]!.totals.transfer).toBe(0);
    expect(() => parseSalesDay(closed({ ...totals, transfer: "0" }), day)).toThrow(
      "SALES_RESPONSE_INVALID",
    );
    expect(() => parseSalesDay(closed({ ...totals, transfer: 5 }), day)).toThrow(
      "SALES_RESPONSE_INVALID",
    );
  });
  it("sends transfer saves through the same validated command path", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            entry: { ...entry, method: "TRANSFER", reference: "TRF-001" },
          }),
        ),
    );
    const result = await client(fetcher).operate(day, {
      ...save,
      method: "TRANSFER",
      reference: "TRF-001",
    });
    expect(result).toMatchObject({ entry: { method: "TRANSFER" } });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      method: "TRANSFER",
    });
    await expect(
      client(fetcher).operate(day, {
        ...save,
        method: "BANK" as "CARD",
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
