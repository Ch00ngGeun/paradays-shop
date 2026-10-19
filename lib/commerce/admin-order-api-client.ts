/** Authenticated, allowlisted order administration. No PG secret or provider response enters the UI. */
import {
  getCheckoutApiConfig,
  type CheckoutAuthorizationTokenProvider,
  type CheckoutApiConfig,
} from "./checkout-api-client";
import { isSyntheticIdentifier } from "./synthetic-identifiers";
export type AdminOrder = Readonly<{
  orderId: string;
  status: string;
  paymentStatus: string;
  total: number;
  createdAt: string;
  lines: readonly Readonly<{
    line: number;
    productId: string;
    name: string;
    selectedSize: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    canceledQuantity: number;
    restoredQuantity: number;
  }>[];
  inventory: null | Readonly<{
    state: "RESERVED" | "DEBITED" | "RELEASED" | "LEGACY";
    fulfillment: "UNCONFIRMED" | "UNSHIPPED" | "SHIPPED";
    expiresAt: string;
    refundedAmount: number;
    lastFailure?: null | Readonly<{ code: string; operationId: string }>;
    pendingRefund: null | Readonly<{
      operationId: string;
      amount: number;
      createdAt: string;
    }>;
  }>;
}>;
type Rows = readonly Readonly<{ line: number; quantity: number }>[];
export type AdminOrderOperation =
  | Readonly<{ action: "reconcile" }>
  | Readonly<{
      action: "fulfillment";
      operationId: string;
      state: "UNSHIPPED" | "SHIPPED";
    }>
  | Readonly<{
      action: "return";
      operationId: string;
      receiptId: string;
      rows: Rows;
      resalableConfirmed: true;
    }>
  | Readonly<{
      action: "refund";
      operationId: string;
      disposition: "UNSHIPPED" | "SHIPPED" | "COMPENSATION";
      cancelReason: string;
      cancelAmount: number;
      rows: Rows;
    }>;
export class AdminOrderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
export function parseAdminOrder(value: unknown): AdminOrder {
  if (
    !record(value) ||
    typeof value.orderId !== "string" ||
    !/^[A-Za-z0-9_-]{6,64}$/.test(value.orderId) ||
    typeof value.status !== "string" ||
    !["PENDING_PAYMENT", "PAID", "FAILED", "CANCELED", "REFUNDED"].includes(
      value.status,
    ) ||
    typeof value.paymentStatus !== "string" ||
    !integer(value.total) ||
    value.total < 1 ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.lines) ||
    !value.lines.length ||
    value.lines.length > 20
  )
    throw new AdminOrderError("ORDER_RESPONSE_INVALID");
  const lines = value.lines.map((row, index) => {
    if (
      !record(row) ||
      row.line !== index ||
      typeof row.productId !== "string" ||
      typeof row.name !== "string" ||
      typeof row.selectedSize !== "string" ||
      !integer(row.quantity, 10) ||
      !row.quantity ||
      !integer(row.unitPrice, 100_000_000) ||
      row.lineTotal !== row.quantity * row.unitPrice ||
      !integer(row.canceledQuantity, row.quantity) ||
      !integer(row.restoredQuantity, row.quantity)
    )
      throw new AdminOrderError("ORDER_RESPONSE_INVALID");
    return {
      line: index,
      productId: row.productId,
      name: row.name,
      selectedSize: row.selectedSize,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal as number,
      canceledQuantity: row.canceledQuantity,
      restoredQuantity: row.restoredQuantity,
    };
  });
  if (lines.reduce((sum, line) => sum + line.lineTotal, 0) !== value.total)
    throw new AdminOrderError("ORDER_RESPONSE_INVALID");
  let inventory: AdminOrder["inventory"] = null;
  if (value.inventory !== null) {
    const i = value.inventory;
    if (
      !record(i) ||
      !["RESERVED", "DEBITED", "RELEASED", "LEGACY"].includes(i.state as string) ||
      !["UNCONFIRMED", "UNSHIPPED", "SHIPPED"].includes(i.fulfillment as string) ||
      typeof i.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(i.expiresAt)) ||
      !integer(i.refundedAmount, value.total)
    )
      throw new AdminOrderError("ORDER_RESPONSE_INVALID");
    let pending: NonNullable<AdminOrder["inventory"]>["pendingRefund"] = null;
    if (i.pendingRefund !== null) {
      const p = i.pendingRefund;
      if (
        !record(p) ||
        typeof p.operationId !== "string" ||
        !integer(p.amount, value.total) ||
        !p.amount ||
        typeof p.createdAt !== "string"
      )
        throw new AdminOrderError("ORDER_RESPONSE_INVALID");
      pending = {
        operationId: p.operationId,
        amount: p.amount,
        createdAt: p.createdAt,
      };
    }
    const failure = i.lastFailure;
    if (
      failure != null &&
      (!record(failure) ||
        typeof failure.code !== "string" ||
        !/^[A-Z0-9_]{1,80}$/.test(failure.code) ||
        typeof failure.operationId !== "string")
    )
      throw new AdminOrderError("ORDER_RESPONSE_INVALID");
    inventory = {
      state: i.state as NonNullable<AdminOrder["inventory"]>["state"],
      fulfillment: i.fulfillment as NonNullable<AdminOrder["inventory"]>["fulfillment"],
      expiresAt: i.expiresAt,
      refundedAmount: i.refundedAmount,
      pendingRefund: pending,
      ...(failure
        ? {
            lastFailure: {
              code: failure.code as string,
              operationId: failure.operationId as string,
            },
          }
        : {}),
    };
  }
  return {
    orderId: value.orderId,
    status: value.status,
    paymentStatus: value.paymentStatus,
    total: value.total,
    createdAt: value.createdAt,
    lines,
    inventory,
  };
}
export function createAdminOrderApiClient({
  authorizationTokenProvider,
  config = getCheckoutApiConfig(),
  fetchImplementation = fetch,
}: Readonly<{
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  config?: CheckoutApiConfig;
  fetchImplementation?: typeof fetch;
}>) {
  async function request(
    orderId: string,
    operation?: AdminOrderOperation,
  ): Promise<AdminOrder> {
    if (isSyntheticIdentifier(orderId))
      throw new AdminOrderError("SIMULATION_ORDER_NOT_ALLOWED", 400);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId))
      throw new AdminOrderError("ORDER_ID_INVALID");
    // Snapshot before async token refresh. Retrying the same operation retains its original request identity.
    const body = operation ? JSON.stringify(operation) : undefined;
    const token = (await authorizationTokenProvider.getAccessToken())?.trim();
    if (!token) throw new AdminOrderError("ADMIN_LOGIN_REQUIRED", 401);
    const response = await fetchImplementation(
      new URL(
        `admin/orders/${encodeURIComponent(orderId)}/refunds`,
        `${config.apiBaseUrl}/`,
      ),
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      },
    );
    const result: unknown = await response.json();
    if (!response.ok)
      throw new AdminOrderError(
        record(result) &&
        typeof result.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(result.code)
          ? result.code
          : "ORDER_OPERATION_FAILED",
        response.status,
      );
    if (!record(result)) throw new AdminOrderError("ORDER_RESPONSE_INVALID");
    const order = parseAdminOrder(result.order);
    if (order.orderId !== orderId) throw new AdminOrderError("ORDER_RESPONSE_INVALID");
    return order;
  }
  return {
    load: (id: string) => request(id),
    operate: (id: string, operation: AdminOrderOperation) => request(id, operation),
  };
}
