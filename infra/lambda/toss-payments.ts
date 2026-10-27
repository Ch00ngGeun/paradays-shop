/**
 * 역할: 서버에서만 Toss Payments Core API를 호출하고, Secrets Manager 비밀키를 캐시함.
 * 기능: 결제 승인·조회·전체 취소 요청과 응답 검증을 제공하며 비밀값·PG 원문 오류를 외부로 노출하지 않음.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** Toss Payments Core API의 고정 HTTPS origin입니다. */
const TOSS_PAYMENTS_API_ORIGIN = "https://api.tosspayments.com";

/** Secrets Manager JSON에 저장할 최소 Toss Payments server credential입니다. */
export type TossPaymentsCredentials = Readonly<{
  secretKey: string;
}>;

/** Core API가 반환하는 결제 정보 중 주문 상태 검증에 필요한 공개 필드입니다. */
export type TossPayment = Readonly<{
  paymentKey: string;
  orderId: string;
  totalAmount: number;
  status: string;
  method: string | null;
  currency: string;
  balanceAmount: number;
  cancels: readonly Readonly<{
    transactionKey: string;
    cancelAmount: number;
    cancelStatus: string;
    cancelReason: string;
    canceledAt?: string;
  }>[];
  approvedAt?: string;
}>;

/** 외부 PG 통신 실패를 Lambda handler가 안전한 502로 바꾸기 위한 오류입니다. */
export class TossPaymentsApiError extends Error {
  constructor(
    readonly status: number | null = null,
    readonly providerCode?: string,
  ) {
    super("TOSS_PAYMENTS_API_ERROR");
    this.name = "TossPaymentsApiError";
  }
}

/** Lambda 컨테이너당 한 번만 Secrets Manager를 조회합니다. */
const secretsManagerClient = new SecretsManagerClient({});
const credentialsBySecretArn = new Map<string, Promise<TossPaymentsCredentials>>();

/** Secrets Manager JSON에서 secretKey만 꺼내며, 누락·형식 오류는 provider unavailable로 처리합니다. */
export function getTossPaymentsCredentials(
  secretArn: string,
): Promise<TossPaymentsCredentials> {
  const cachedCredentials = credentialsBySecretArn.get(secretArn);

  if (cachedCredentials) {
    return cachedCredentials;
  }

  const credentials = readTossPaymentsCredentials(secretArn).catch((error: unknown) => {
    credentialsBySecretArn.delete(secretArn);
    throw error;
  });

  credentialsBySecretArn.set(secretArn, credentials);

  return credentials;
}

/** orderId·금액·paymentKey를 Toss 승인 API로 전달하고 응답을 최소 필드로 검증합니다. */
export async function confirmTossPayment({
  credentials,
  paymentKey,
  orderId,
  amount,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
  orderId: string;
  amount: number;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "POST",
    path: "/v1/payments/confirm",
    idempotencyKey: `confirm-${orderId}`,
    body: { paymentKey, orderId, amount },
  });
}

/** 서명 없는 일반 결제 webhook은 paymentKey로 Toss 서버에 재조회해 신뢰합니다. */
export async function getTossPayment({
  credentials,
  paymentKey,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "GET",
    path: `/v1/payments/${encodeURIComponent(paymentKey)}`,
  });
}

/** 관리자 full refund 요청을 PG에 전달합니다. 부분 취소는 정책 확정 후 별도 계약으로 추가합니다. */
export async function cancelTossPayment({
  credentials,
  paymentKey,
  orderId,
  cancelReason,
  cancelAmount,
  operationId,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
  orderId: string;
  cancelReason: string;
  cancelAmount?: number;
  operationId?: string;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "POST",
    path: `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
    idempotencyKey: operationId ? `cancel-${operationId}` : `refund-${orderId}`,
    body: { cancelReason, ...(cancelAmount === undefined ? {} : { cancelAmount }) },
  });
}

/** Secrets Manager가 반환한 JSON을 파싱하고 실제 server secret 외의 속성은 무시합니다. */
async function readTossPaymentsCredentials(
  secretArn: string,
): Promise<TossPaymentsCredentials> {
  let response;

  try {
    response = await secretsManagerClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
  } catch {
    throw new TossPaymentsApiError();
  }

  if (!response.SecretString) {
    throw new TossPaymentsApiError();
  }

  try {
    const parsedSecret: unknown = JSON.parse(response.SecretString);

    if (
      !isRecord(parsedSecret) ||
      typeof parsedSecret.secretKey !== "string" ||
      !parsedSecret.secretKey.trim()
    ) {
      throw new Error("secretKey is missing");
    }

    return { secretKey: parsedSecret.secretKey.trim() };
  } catch {
    throw new TossPaymentsApiError();
  }
}

/** Basic 인증의 colon까지 포함해 Toss Payments Core API 요청을 만들고 응답을 검증합니다. */
async function requestTossPayment({
  credentials,
  method,
  path,
  body,
  idempotencyKey,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}>): Promise<TossPayment> {
  let response: Response;

  try {
    response = await fetch(new URL(path, TOSS_PAYMENTS_API_ORIGIN), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.secretKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new TossPaymentsApiError();
  }

  if (!response.ok) {
    let code: string | undefined;
    try {
      const error: unknown = await response.json();
      if (
        isRecord(error) &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(error.code)
      )
        code = error.code;
    } catch {
      /* no verified structured rejection */
    }
    throw new TossPaymentsApiError(response.status, code);
  }

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    throw new TossPaymentsApiError(response.status);
  }

  const payment = parseTossPayment(responseBody);
  if (!payment) {
    throw new TossPaymentsApiError(response.status);
  }

  return payment;
}

/** Toss API의 결제 응답이 서버 비교에 필요한 필드를 갖췄는지 좁힙니다. */
export function parseTossPayment(value: unknown): TossPayment | null {
  if (
    !(
      isRecord(value) &&
      typeof value.paymentKey === "string" &&
      Boolean(value.paymentKey) &&
      typeof value.orderId === "string" &&
      Boolean(value.orderId) &&
      typeof value.totalAmount === "number" &&
      Number.isSafeInteger(value.totalAmount) &&
      value.totalAmount >= 0 &&
      typeof value.balanceAmount === "number" &&
      Number.isSafeInteger(value.balanceAmount) &&
      value.balanceAmount >= 0 &&
      value.balanceAmount <= value.totalAmount &&
      (value.method === null || typeof value.method === "string") &&
      typeof value.currency === "string" &&
      typeof value.status === "string" &&
      Boolean(value.status) &&
      (value.approvedAt == null || typeof value.approvedAt === "string")
    )
  )
    return null;
  const cancels = value.cancels == null ? [] : value.cancels;
  if (
    !Array.isArray(cancels) ||
    cancels.length > 200 ||
    !cancels.every(
      (c) =>
        isRecord(c) &&
        typeof c.transactionKey === "string" &&
        c.transactionKey.length > 0 &&
        typeof c.cancelReason === "string" &&
        typeof c.cancelStatus === "string" &&
        typeof c.cancelAmount === "number" &&
        (c.canceledAt === undefined ||
          (typeof c.canceledAt === "string" &&
            Number.isFinite(Date.parse(c.canceledAt)))) &&
        Number.isSafeInteger(c.cancelAmount) &&
        c.cancelAmount > 0,
    )
  )
    return null;
  return {
    paymentKey: value.paymentKey as string,
    orderId: value.orderId as string,
    totalAmount: value.totalAmount as number,
    balanceAmount: value.balanceAmount as number,
    status: value.status as string,
    method: value.method as string | null,
    currency: value.currency as string,
    cancels,
    ...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
  };
}

/** Monetary proof only: physical restocking additionally needs the order's debit/fulfillment ledger. */
export function paymentMatchesOrder(
  payment: TossPayment,
  order: { orderId: string; total: number },
  paymentKey: string,
): boolean {
  return (
    payment.orderId === order.orderId &&
    payment.paymentKey === paymentKey &&
    payment.totalAmount === order.total &&
    ["카드", "간편결제"].includes(payment.method ?? "") &&
    payment.currency === "KRW"
  );
}
/** Only explicit, documented non-processing rejections qualify. Never classify timeout/5xx/already-processing as failure. */
export function definitiveApprovalRejection(
  error: unknown,
): error is TossPaymentsApiError {
  return (
    error instanceof TossPaymentsApiError &&
    [400, 401, 403, 404].includes(error.status ?? 0) &&
    [
      "NOT_FOUND_PAYMENT",
      "NOT_FOUND_PAYMENT_SESSION",
      "REJECT_CARD_PAYMENT",
      "REJECT_CARD_COMPANY",
      "INVALID_REJECT_CARD",
      "INVALID_STOPPED_CARD",
      "INVALID_CARD_LOST_OR_STOLEN",
      "BELOW_MINIMUM_AMOUNT",
      "INVALID_API_KEY",
      "UNAUTHORIZED_KEY",
    ].includes(error.providerCode ?? "")
  );
}
export function definitiveRefundRejection(
  error: unknown,
): error is TossPaymentsApiError {
  return (
    error instanceof TossPaymentsApiError &&
    [400, 403].includes(error.status ?? 0) &&
    [
      "EXCEED_CANCEL_AMOUNT_DISCOUNT_AMOUNT",
      "REFUND_REJECTED",
      "NOT_CANCELABLE_AMOUNT",
      "NOT_CANCELABLE_PAYMENT",
      "EXCEED_MAX_REFUND_DUE",
    ].includes(error.providerCode ?? "")
  );
}
export function verifiedCancellation(payment: TossPayment): boolean {
  const keys = new Set(payment.cancels.map((c) => c.transactionKey));
  return (
    ["CANCELED", "PARTIAL_CANCELED"].includes(payment.status) &&
    payment.cancels.length > 0 &&
    keys.size === payment.cancels.length &&
    payment.cancels.every((c) => c.cancelStatus === "DONE") &&
    payment.cancels.reduce((sum, c) => sum + c.cancelAmount, 0) ===
      payment.totalAmount - payment.balanceAmount &&
    (payment.status === "CANCELED"
      ? payment.balanceAmount === 0
      : payment.balanceAmount > 0)
  );
}

/** external API JSON value의 객체 여부만 검증합니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
