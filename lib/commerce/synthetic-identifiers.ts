// 역할: TEST 접두사 합성 교육용 ID를 판별해 주문·결제·관리자 주문 요청에서 거부하게 합니다.
/** 합성 교육용 ID는 클라이언트 예약 이름공간이며 API·결제를 우회하는 수단이 아닙니다. */
export function isSyntheticIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^TEST(?:[_-]|$)/i.test(value.trim());
}
