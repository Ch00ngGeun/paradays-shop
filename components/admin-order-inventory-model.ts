// 역할: 주문 취소·반품 재고 패널이 쓰는 금액 표기, 재고 원장 상태 이름(한·영), 서버가 확정 거절한 오류 코드 목록을 둡니다.
import type { Locale } from "@/types/store";

export const money = (amount: number, locale: Locale) =>
  locale === "ko"
    ? `${amount.toLocaleString("ko-KR")}원`
    : `KRW ${amount.toLocaleString("en-US")}`;
export const stateLabels = {
  ko: {
    UNCONFIRMED: "출고 여부 미확인",
    UNSHIPPED: "미출고 확인됨",
    SHIPPED: "출고 확인됨",
    RESERVED: "결제 결과 확인 대기 · 재고 예약 중",
    DEBITED: "판매 재고 차감 완료",
    RELEASED: "결제 실패·취소 확인 후 예약 해제됨",
    LEGACY: "구형 주문 · 금액 환불만 가능 · 재입고 금지",
  },
  en: {
    UNCONFIRMED: "Shipment not confirmed",
    UNSHIPPED: "Confirmed not shipped",
    SHIPPED: "Confirmed shipped",
    RESERVED: "Awaiting payment result · Stock reserved",
    DEBITED: "Sold stock deducted",
    RELEASED: "Reservation released after payment failure or cancellation",
    LEGACY: "Legacy order · Amount refund only · No restock",
  },
};
export type Notice = string | Readonly<Record<Locale, string>>;
export const DEFINITE_REJECTIONS = new Set([
  "FULFILLMENT_INVALID",
  "REFUND_IN_PROGRESS",
  "FULFILLMENT_CANNOT_REVERSE_SHIPMENT",
  "ORDER_NOT_SHIPPABLE",
  "RETURN_INSPECTION_REQUIRED",
  "RETURN_SHIPMENT_CONFIRMATION_REQUIRED",
  "INVENTORY_DEBIT_PROOF_REQUIRED",
  "INVENTORY_ROWS_INVALID",
  "INVENTORY_RESTORE_EXCEEDS_DEBIT",
  "INVENTORY_OPERATION_REUSED",
  "INVENTORY_OPERATION_LIMIT",
  "REFUND_BODY_INVALID",
  "REFUND_AMOUNT_EXCEEDS_BALANCE",
  "REFUND_FULFILLMENT_CONFIRMATION_REQUIRED",
  "REFUND_QUANTITY_EXCEEDS_ORDER",
  "REFUND_LINE_AMOUNT_MISMATCH",
  "COMPENSATION_CANNOT_RESTOCK",
]);
