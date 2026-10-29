/**
 * 역할: Lambda의 주문 생성·상태 전이·금액 계산을 Toss API와 DynamoDB 구현에서 분리함.
 * 기능: 서버 카탈로그 기준 가격 검증, 옵션 중복 통합, 안전한 주문 이름·결제 상태 변환을 제공함.
 */

import type { ServerCatalogProduct } from "./catalog.js";

/** 브라우저가 보낼 수 있는 주문 라인의 최소 형식입니다. */
export type CheckoutRequestLine = Readonly<{
  productId: string;
  selectedSize: string;
  quantity: number;
}>;

/** 서버가 가격을 고정해 DynamoDB에 넣는 주문 라인입니다. */
export type OrderLineSnapshot = Readonly<{
  productId: string;
  name: string;
  selectedSize: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}>;

/** 일반 결제와 비동기 가상계좌 상태를 포함하는 주문 상태입니다. */
export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "FAILED"
  | "CANCELED"
  | "REFUNDED";

/** 서버 계산이 끝난 주문의 결제 전 스냅샷입니다. */
export type CalculatedOrder = Readonly<{
  currency: "KRW";
  lines: readonly OrderLineSnapshot[];
  subtotal: number;
  total: number;
  orderName: string;
}>;

/** 호출자가 공개 API 오류로 변환할 수 있는 도메인 오류입니다. */
export class OrderValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OrderValidationError";
  }
}

/** 결제 공격·실수 모두를 제한하기 위한 장바구니 경계입니다. */
const MAX_CHECKOUT_LINES = 20;
const MAX_QUANTITY_PER_LINE = 10;

/** JSON body가 주문 라인 배열인지 최소한의 런타임 검증을 수행합니다. */
export function parseCheckoutRequestLines(value: unknown): CheckoutRequestLine[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CHECKOUT_LINES
  ) {
    throw new OrderValidationError("CHECKOUT_LINES_INVALID");
  }

  return value.map((line) => {
    if (!isRecord(line)) {
      throw new OrderValidationError("CHECKOUT_LINE_INVALID");
    }

    const productId = readTrimmedString(line.productId);
    const selectedSize = readTrimmedString(line.selectedSize);
    const quantity = line.quantity;

    if (
      !productId ||
      productId.length > 120 ||
      !selectedSize ||
      selectedSize.length > 80 ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY_PER_LINE
    ) {
      throw new OrderValidationError("CHECKOUT_LINE_INVALID");
    }

    return { productId, selectedSize, quantity };
  });
}

/** 같은 상품·사이즈 중복 행을 합쳐 서버 금액 계산의 모호성을 없앱니다. */
function mergeDuplicateLines(lines: readonly CheckoutRequestLine[]) {
  const quantities = new Map<string, CheckoutRequestLine>();

  for (const line of lines) {
    const lineKey = `${line.productId}\u0000${line.selectedSize}`;
    const existing = quantities.get(lineKey);
    const quantity = (existing?.quantity ?? 0) + line.quantity;

    if (quantity > MAX_QUANTITY_PER_LINE) {
      throw new OrderValidationError("CHECKOUT_QUANTITY_LIMIT_EXCEEDED");
    }

    quantities.set(lineKey, { ...line, quantity });
  }

  return [...quantities.values()];
}

/** 상품·옵션·수량을 검증하고 모든 금액을 서버 카탈로그로 재계산합니다. */
export function calculateOrder(
  requestLines: readonly CheckoutRequestLine[],
  catalog: readonly ServerCatalogProduct[],
): CalculatedOrder {
  const catalogById = new Map(catalog.map((product) => [product.id, product]));
  const mergedLines = mergeDuplicateLines(requestLines);
  const lines = mergedLines.map((requestLine) => {
    const product = catalogById.get(requestLine.productId);

    if (!product) {
      throw new OrderValidationError("CHECKOUT_PRODUCT_NOT_FOUND");
    }

    if (!product.sizes.includes(requestLine.selectedSize)) {
      throw new OrderValidationError("CHECKOUT_SIZE_INVALID");
    }

    const lineTotal = product.price * requestLine.quantity;

    return {
      productId: product.id,
      name: product.name,
      selectedSize: requestLine.selectedSize,
      quantity: requestLine.quantity,
      unitPrice: product.price,
      lineTotal,
    } satisfies OrderLineSnapshot;
  });
  const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);

  if (!Number.isSafeInteger(subtotal) || subtotal < 1) {
    throw new OrderValidationError("CHECKOUT_AMOUNT_INVALID");
  }

  return {
    currency: "KRW",
    lines,
    subtotal,
    total: subtotal,
    orderName: createOrderName(lines),
  };
}

/** Toss의 100자 주문명 제한 안에서 대표 상품과 추가 건수를 표현합니다. */
function createOrderName(lines: readonly OrderLineSnapshot[]) {
  // Toss shows the order name on one line, so a product name entered on two lines is joined with a space.
  const firstName = (lines[0]?.name ?? "PARADAYS Order").replace(/\s+/g, " ").trim();
  const suffix = lines.length > 1 ? ` 외 ${lines.length - 1}건` : "";
  const maximumFirstNameLength = Math.max(1, 100 - suffix.length);

  return `${firstName.slice(0, maximumFirstNameLength)}${suffix}`;
}

/** unknown JSON 값이 객체인지 검사하는 공통 좁히기입니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 문자열 입력에서 빈 값·공백을 제외합니다. */
function readTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
