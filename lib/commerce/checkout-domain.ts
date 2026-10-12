// 역할: AWS Lambda가 사용할 수 있는 결제 전 주문 검증과 주문 상태 전이 규칙을 외부 PG·UI로부터 분리합니다.
import type { Product } from "@/types/store";

/** 브라우저가 보낼 수 있는 최소 Checkout 정보. 가격과 상품명은 의도적으로 받지 않습니다. */
export type CheckoutRequestLine = {
  productId: string;
  quantity: number;
  selectedSize: string;
};

/** 서버가 카탈로그로 재계산한 뒤 주문에 고정할 상품 스냅샷입니다. */
export type OrderLineSnapshot = {
  productId: string;
  name: string;
  quantity: number;
  selectedSize: string;
  unitPrice: number;
  lineTotal: number;
};

/** 결제 시작부터 환불까지 허용하는 서버 주문 상태입니다. */
export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PAID"
  | "FAILED"
  | "CANCELED"
  | "REFUNDED";

/** PG 선택은 AWS 인프라 배포 전에 확정하되, 애플리케이션 계약은 공급자에 의존하지 않게 둡니다. */
export type PaymentProvider = "toss" | "portone" | "stripe";

/** Lambda가 DynamoDB에 기록할 주문 생성 전 서버 계산 결과입니다. */
export type ServerCalculatedOrder = {
  lines: OrderLineSnapshot[];
  subtotal: number;
  total: number;
  currency: "KRW";
  status: "PENDING_PAYMENT";
};

/** PG adapter가 제공해야 하는 최소 서버 측 결제 계약입니다. */
export type PaymentGateway = {
  createCheckoutSession: (input: {
    orderId: string;
    amount: number;
    orderName: string;
  }) => Promise<{
    checkoutUrl: string;
    providerOrderId: string;
  }>;
  confirmPayment: (input: {
    amount: number;
    orderId: string;
    paymentKey: string;
  }) => Promise<{
    providerPaymentId: string;
    status: "PAID" | "FAILED";
  }>;
  verifyWebhook: (input: {
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: string;
  }) => Promise<{
    eventId: string;
    orderId: string;
    paymentStatus: "PAID" | "FAILED" | "CANCELED";
  }>;
};

const MAX_QUANTITY_PER_LINE = 10;

const allowedOrderTransitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ["PAID", "FAILED", "CANCELED"],
  PAID: ["REFUNDED"],
  FAILED: [],
  CANCELED: [],
  REFUNDED: [],
};

/** 브라우저 요청에서 온 상품 ID·옵션·수량만으로 신뢰할 수 있는 주문 금액을 계산합니다. */
export function calculateServerOrder(
  requestLines: readonly CheckoutRequestLine[],
  catalog: readonly Product[],
): ServerCalculatedOrder {
  if (requestLines.length === 0) {
    throw new Error("CHECKOUT_CART_EMPTY");
  }

  const catalogById = new Map(catalog.map((product) => [product.id, product]));
  const lines = requestLines.map((requestLine) => {
    const product = catalogById.get(requestLine.productId);

    if (!product) {
      throw new Error("CHECKOUT_PRODUCT_NOT_FOUND");
    }

    if (!Number.isInteger(requestLine.quantity) || requestLine.quantity < 1) {
      throw new Error("CHECKOUT_QUANTITY_INVALID");
    }

    if (requestLine.quantity > MAX_QUANTITY_PER_LINE) {
      throw new Error("CHECKOUT_QUANTITY_LIMIT_EXCEEDED");
    }

    if (!product.sizes.includes(requestLine.selectedSize)) {
      throw new Error("CHECKOUT_SIZE_INVALID");
    }

    const lineTotal = product.price * requestLine.quantity;

    return {
      productId: product.id,
      name: product.name,
      quantity: requestLine.quantity,
      selectedSize: requestLine.selectedSize,
      unitPrice: product.price,
      lineTotal,
    };
  });
  const subtotal = lines.reduce((total, line) => total + line.lineTotal, 0);

  return {
    lines,
    subtotal,
    total: subtotal,
    currency: "KRW",
    status: "PENDING_PAYMENT",
  };
}

/** 웹훅·승인 API가 주문 상태를 안전하게 이동시킬 수 있는지 판별합니다. */
export function canTransitionOrder(
  currentStatus: OrderStatus,
  nextStatus: OrderStatus,
) {
  return allowedOrderTransitions[currentStatus].includes(nextStatus);
}

/** 허용되지 않은 상태 전이는 오류로 막아 결제 이벤트의 역행을 방지합니다. */
export function transitionOrder(currentStatus: OrderStatus, nextStatus: OrderStatus) {
  if (!canTransitionOrder(currentStatus, nextStatus)) {
    throw new Error("ORDER_STATUS_TRANSITION_INVALID");
  }

  return nextStatus;
}
