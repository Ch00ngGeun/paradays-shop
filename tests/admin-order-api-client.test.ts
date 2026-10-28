import { describe, it, expect, vi } from "vitest";
import {
  createAdminOrderApiClient,
  parseAdminOrder,
} from "@/lib/commerce/admin-order-api-client";
const order = {
  orderId: "pd_order",
  status: "PAID",
  paymentStatus: "DONE",
  total: 100,
  createdAt: "2026-10-15T00:00:00Z",
  lines: [
    {
      line: 0,
      productId: "prd_a",
      name: "Deck",
      selectedSize: "8",
      quantity: 1,
      unitPrice: 100,
      lineTotal: 100,
      canceledQuantity: 0,
      restoredQuantity: 0,
    },
  ],
  inventory: {
    state: "DEBITED",
    fulfillment: "SHIPPED",
    expiresAt: "2026-10-15T00:00:00Z",
    refundedAmount: 0,
    pendingRefund: null,
  },
};
describe("order operations", () => {
  it("TEST orders cannot enter real order lookup or any mutation, before auth/network", async () => {
    const getAccessToken = vi.fn(() => "fake-admin");
    const fetcher = vi.fn();
    const client = createAdminOrderApiClient({
      config: { apiBaseUrl: "https://api.example.test" },
      authorizationTokenProvider: { getAccessToken },
      fetchImplementation: fetcher,
    });
    for (const id of ["TEST_demo-order", "test-demo-order", " TEST_demo-order "]) {
      await expect(client.load(id)).rejects.toThrow("SIMULATION_ORDER_NOT_ALLOWED");
      await expect(client.operate(id, { action: "reconcile" })).rejects.toThrow(
        "SIMULATION_ORDER_NOT_ALLOWED",
      );
      await expect(
        client.operate(id, {
          action: "refund",
          operationId: "test-operation-001",
          disposition: "COMPENSATION",
          cancelAmount: 1,
          cancelReason: "synthetic",
          rows: [],
        }),
      ).rejects.toThrow("SIMULATION_ORDER_NOT_ALLOWED");
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("legacy financial summaries never claim a proven debit", () => {
    const legacy = parseAdminOrder({
      ...order,
      inventory: { ...order.inventory, state: "LEGACY" },
    });
    expect(legacy.inventory?.state).toBe("LEGACY");
    expect(legacy.lines[0]!.restoredQuantity).toBe(0);
  });
  it("allowlists server summary and validates restoration bounds", () => {
    expect(parseAdminOrder({ ...order, providerPaymentKey: "private" })).toEqual(order);
    expect(() =>
      parseAdminOrder({
        ...order,
        lines: [{ ...order.lines[0], restoredQuantity: 2 }],
      }),
    ).toThrow();
  });
  it("requires auth and targets the authenticated commerce API", async () => {
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.example.test/prod/admin/orders/pd_order/refunds",
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer fake-admin",
      );
      return new Response(JSON.stringify({ order }), { status: 200 });
    });
    const client = createAdminOrderApiClient({
      config: { apiBaseUrl: "https://api.example.test/prod" },
      authorizationTokenProvider: { getAccessToken: () => "fake-admin" },
      fetchImplementation: fetcher,
    });
    expect(await client.load("pd_order")).toEqual(order);
  });
  it("snapshots operation before async token and keeps the caller's stable id", async () => {
    let resume!: (token: string) => void;
    const auth = new Promise<string>((resolve) => {
      resume = resolve;
    });
    const operation = {
      action: "return" as const,
      operationId: "return_operation_01",
      receiptId: "RMA-1",
      rows: [{ line: 0, quantity: 1 }],
      resalableConfirmed: true as const,
    };
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).rows[0].quantity).toBe(1);
      return new Response(JSON.stringify({ order }), { status: 200 });
    });
    const client = createAdminOrderApiClient({
      config: { apiBaseUrl: "https://api.example.test" },
      authorizationTokenProvider: { getAccessToken: () => auth },
      fetchImplementation: fetcher,
    });
    const pending = client.operate("pd_order", operation);
    operation.rows[0]!.quantity = 2;
    resume("fake");
    await pending;
  });
  it("missing auth never sends any request", async () => {
    const fetcher = vi.fn();
    const client = createAdminOrderApiClient({
      config: { apiBaseUrl: "https://api.example.test" },
      authorizationTokenProvider: { getAccessToken: () => null },
      fetchImplementation: fetcher,
    });
    await expect(client.load("pd_order")).rejects.toThrow("ADMIN_LOGIN_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
