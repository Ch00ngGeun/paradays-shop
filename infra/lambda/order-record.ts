/**
 * 역할: DynamoDB에 저장할 주문 레코드와 복구 가능한 멱등·반환 토큰 규칙을 정의함.
 * 기능: 사용자·멱등성 키 기반 주문 ID, PG redirect 반환 토큰, 공개 주문 요약을 만듦.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { OrderLineSnapshot, OrderStatus } from "./order-domain.js";

/** DynamoDB order 테이블의 한 주문 레코드입니다. */
export type OrderRecord = Readonly<{
  orderId: string;
  userSub: string;
  status: OrderStatus;
  paymentStatus: string;
  provider: "toss";
  currency: "KRW";
  subtotal: number;
  total: number;
  orderName: string;
  lines: readonly OrderLineSnapshot[];
  idempotencyKeyHash: string;
  requestFingerprint: string;
  checkoutReturnTokenHash: string;
  checkoutReturnExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  providerPaymentKey?: string;
  providerPaymentStatus?: string;
  paidAt?: string;
  refundedAt?: string;
}>;

/** 결제 성공 뒤 장바구니 UI와 주문 내역이 쓸 수 있는 민감정보 없는 요약입니다. */
export type PublicOrderSummary = Readonly<{
  orderId: string;
  orderName: string;
  status: OrderStatus;
  paymentStatus: string;
  total: number;
  currency: "KRW";
  createdAt: string;
}>;

/** 입력 값을 SHA-256 base64url로 해시해 원문 멱등 키·반환 토큰을 DB에 저장하지 않습니다. */
export function createDigest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

/** 사용자·멱등 키에 대해 한 주문 ID만 만들도록 결정적이고 Toss 허용 문자만 사용합니다. */
export function createOrderId(userSub: string, idempotencyKey: string) {
  const digest = createDigest(`order:${userSub}:${idempotencyKey}`);

  return `pd_${digest.slice(0, 48)}`;
}

/** 동일 주문 입력인지 확인하는 서버 기준 fingerprint입니다. */
export function createRequestFingerprint(lines: readonly OrderLineSnapshot[]) {
  const canonicalLines = [...lines]
    .sort((left, right) => {
      const leftKey = `${left.productId}\u0000${left.selectedSize}`;
      const rightKey = `${right.productId}\u0000${right.selectedSize}`;

      return leftKey.localeCompare(rightKey);
    })
    .map((line) => ({
      productId: line.productId,
      selectedSize: line.selectedSize,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }));

  return createDigest(JSON.stringify(canonicalLines));
}

/** Toss customerKey는 이메일·전화번호 대신 Cognito sub의 일방향 해시로 만듭니다. */
export function createCustomerKey(userSub: string) {
  return `pd_${createDigest(`customer:${userSub}`).slice(0, 48)}`;
}

/** PG redirect 후 1회 승인 API를 호출할 수 있는 고엔트로피 반환 토큰을 서버 비밀값으로 도출합니다. */
export function createCheckoutReturnToken(
  tossSecretKey: string,
  orderId: string,
  userSub: string,
) {
  return createHmac("sha256", tossSecretKey)
    .update(`checkout-return:${orderId}:${userSub}`)
    .digest("base64url");
}

/** 저장된 토큰 해시와 제출된 토큰을 일정 시간 비교해 redirect query 변조를 막습니다. */
export function matchesCheckoutReturnToken(
  expectedTokenHash: string,
  submittedToken: string,
) {
  const expectedBytes = Buffer.from(expectedTokenHash, "utf8");
  const actualBytes = Buffer.from(createDigest(submittedToken), "utf8");

  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

/** DynamoDB 레코드에서 클라이언트에 반환 가능한 주문 요약만 만듭니다. */
export function toPublicOrderSummary(order: OrderRecord): PublicOrderSummary {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
    currency: order.currency,
    createdAt: order.createdAt,
  };
}

/** unknown DynamoDB item이 현재 주문 레코드의 필수 필드를 갖는지 확인합니다. */
export function isOrderRecord(value: unknown): value is OrderRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.orderId === "string" &&
    typeof value.userSub === "string" &&
    isOrderStatus(value.status) &&
    typeof value.paymentStatus === "string" &&
    value.provider === "toss" &&
    value.currency === "KRW" &&
    typeof value.subtotal === "number" &&
    typeof value.total === "number" &&
    typeof value.orderName === "string" &&
    Array.isArray(value.lines) &&
    typeof value.idempotencyKeyHash === "string" &&
    typeof value.requestFingerprint === "string" &&
    typeof value.checkoutReturnTokenHash === "string" &&
    typeof value.checkoutReturnExpiresAt === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/** 허용된 내부 주문 상태만 DynamoDB에서 복원합니다. */
function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    value === "PENDING_PAYMENT" ||
    value === "PAID" ||
    value === "FAILED" ||
    value === "CANCELED" ||
    value === "REFUNDED"
  );
}

/** unknown 값이 객체인지 좁혀 DynamoDB item 검증에 사용합니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
