/** Browser-memory teaching model only. No API, auth, payment, storage, or production-order adapter. */
import type { Locale } from "@/types/store";

export type SimulationCommand =
  | Readonly<{ type: "approve" }>
  | Readonly<{ type: "fulfillment"; state: "UNSHIPPED" | "SHIPPED" }>
  | Readonly<{ type: "cancel-unshipped" | "refund-shipped"; quantity: number }>
  | Readonly<{ type: "compensate"; amount: number }>
  | Readonly<{
      type: "receive-return";
      quantity: number;
      receiptId: string;
      resalableConfirmed: boolean;
    }>;
export type SimulationAction = Readonly<{ operationId: string }> & SimulationCommand;
export type SimulationState = Readonly<{
  kind: "LOCAL_SIMULATION";
  orderId: string;
  productId: "TEST_PRODUCT_DECK";
  productName: "[테스트] 합성 데크";
  initialStock: 10;
  stock: number;
  orderedQuantity: 2;
  unitPrice: 10_000;
  paid: boolean;
  fulfillment: "UNCONFIRMED" | "UNSHIPPED" | "SHIPPED";
  shippedQuantity: number;
  unshippedCanceled: number;
  refundedItemQuantity: number;
  returnedResalable: number;
  refundedAmount: number;
  operations: ReadonlyMap<string, string>;
  receipts: ReadonlyMap<string, number>;
  history: readonly string[];
}>;
export class SimulationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const reject = (code: string, message: string): never => {
  throw new SimulationError(code, message);
};
const localize = (locale: Locale) => (ko: string, en: string) =>
  locale === "ko" ? ko : en;
const positiveInteger = (value: number, max: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= max;
export function createSimulation(id: string, locale: Locale = "ko"): SimulationState {
  const t = localize(locale);
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(id))
    reject(
      "SESSION_INVALID",
      t("테스트 번호를 새로 생성해 주세요.", "Create a new test number."),
    );
  return {
    kind: "LOCAL_SIMULATION",
    orderId: `TEST_${id}`,
    productId: "TEST_PRODUCT_DECK",
    productName: "[테스트] 합성 데크",
    initialStock: 10,
    stock: 10,
    orderedQuantity: 2,
    unitPrice: 10_000,
    paid: false,
    fulfillment: "UNCONFIRMED",
    shippedQuantity: 0,
    unshippedCanceled: 0,
    refundedItemQuantity: 0,
    returnedResalable: 0,
    refundedAmount: 0,
    operations: new Map(),
    receipts: new Map(),
    history: [
      t(
        "모의 주문 생성: 합성 상품 2개 · 가상금액 20,000원 · 테스트 재고 10개",
        "Mock order created: 2 synthetic items · Virtual amount KRW 20,000 · Test stock 10",
      ),
    ],
  };
}
export const simulationBalance = (state: SimulationState) =>
  state.orderedQuantity * state.unitPrice - state.refundedAmount;
export function applySimulation(
  state: SimulationState,
  action: SimulationAction,
  locale: Locale = "ko",
): Readonly<{ state: SimulationState; message: string; replayed: boolean }> {
  const t = localize(locale);
  if (state.kind !== "LOCAL_SIMULATION" || !state.orderId.startsWith("TEST_"))
    reject(
      "NOT_SIMULATION",
      t(
        "모의 테스트 데이터만 처리할 수 있습니다.",
        "Only mock test data can be processed.",
      ),
    );
  if (
    typeof action.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(action.operationId)
  )
    reject(
      "OPERATION_INVALID",
      t("테스트 동작 번호가 올바르지 않습니다.", "The test action number is invalid."),
    );
  const receipt =
    action.type === "receive-return" ? action.receiptId.trim().toUpperCase() : "";
  const fingerprint = JSON.stringify(
    action.type === "fulfillment"
      ? [action.type, action.state]
      : action.type === "compensate"
        ? [action.type, action.amount]
        : action.type === "receive-return"
          ? [action.type, receipt, action.quantity, action.resalableConfirmed]
          : action.type === "approve"
            ? [action.type]
            : [action.type, action.quantity],
  );
  const previous = state.operations.get(action.operationId);
  if (previous !== undefined) {
    if (previous !== fingerprint)
      reject(
        "OPERATION_REUSED",
        t(
          "같은 테스트 동작 번호의 내용을 변경할 수 없습니다.",
          "The content of the same test action number cannot change.",
        ),
      );
    return {
      state,
      message: t(
        "같은 모의 요청은 이미 처리됐습니다. 재고와 가상금액을 다시 바꾸지 않았습니다.",
        "The same mock request was already processed. Stock and virtual amounts were not changed again.",
      ),
      replayed: true,
    };
  }
  if (action.type !== "approve" && !state.paid)
    reject(
      "APPROVAL_REQUIRED",
      t("먼저 모의 승인을 진행해 주세요.", "Run the mock approval first."),
    );
  if (state.operations.size >= 100)
    reject(
      "OPERATION_LIMIT",
      t(
        "테스트 동작 한도에 도달했습니다. 초기화 후 다시 체험해 주세요.",
        "The test action limit was reached. Reset and try again.",
      ),
    );
  let next = state;
  let message = "";
  switch (action.type) {
    case "approve":
      if (state.paid)
        return {
          state,
          message: t(
            "이미 모의 승인된 주문입니다. 다시 차감하지 않았습니다.",
            "This order is already mock approved. Nothing was deducted again.",
          ),
          replayed: true,
        };
      next = { ...state, paid: true, stock: state.stock - state.orderedQuantity };
      message = t(
        "모의 승인 완료: 테스트 재고 10 → 8개 (2개 차감)",
        "Mock approval done: Test stock 10 → 8 (2 deducted)",
      );
      break;
    case "fulfillment":
      if (state.fulfillment === "SHIPPED" && action.state !== "SHIPPED")
        reject(
          "SHIPMENT_IRREVERSIBLE",
          t(
            "출고 완료를 미출고로 되돌릴 수 없습니다. 반품 검수 경로를 사용해 주세요.",
            "A shipped order cannot go back to unshipped. Use the return inspection path.",
          ),
        );
      if (!["UNSHIPPED", "SHIPPED"].includes(action.state))
        reject(
          "FULFILLMENT_INVALID",
          t(
            "모의 출고 상태가 올바르지 않습니다.",
            "The mock shipment status is invalid.",
          ),
        );
      if (
        action.state === "SHIPPED" &&
        (simulationBalance(state) === 0 ||
          state.orderedQuantity - state.unshippedCanceled === 0)
      )
        reject(
          "NOT_SHIPPABLE",
          t(
            "환불 완료 또는 남은 상품이 없는 주문은 새 출고 처리할 수 없습니다.",
            "A fully refunded order or one with no items left cannot be shipped.",
          ),
        );
      next = {
        ...state,
        fulfillment: action.state,
        shippedQuantity:
          action.state === "SHIPPED"
            ? state.orderedQuantity - state.unshippedCanceled
            : 0,
      };
      message =
        action.state === "SHIPPED"
          ? t(
              "모의 출고 확인: 이후 환불만으로는 재입고되지 않습니다.",
              "Mock shipment confirmed: A later refund alone does not restock.",
            )
          : t(
              "모의 미출고 확인: 취소 완료 수량만 복원할 수 있습니다.",
              "Mock not-shipped confirmed: Only canceled quantities can be restored.",
            );
      break;
    case "cancel-unshipped":
    case "refund-shipped": {
      const expected = action.type === "cancel-unshipped" ? "UNSHIPPED" : "SHIPPED";
      if (state.fulfillment !== expected)
        reject(
          "FULFILLMENT_REQUIRED",
          expected === "UNSHIPPED"
            ? t(
                "모의 미출고 확인 후 취소해 주세요.",
                "Confirm mock not-shipped before canceling.",
              )
            : t(
                "모의 출고 확인 후 출고 상품 환불을 진행해 주세요.",
                "Confirm mock shipment before refunding shipped items.",
              ),
        );
      if (
        !positiveInteger(
          action.quantity,
          state.orderedQuantity - state.refundedItemQuantity,
        )
      )
        reject(
          "QUANTITY_EXCEEDED",
          t(
            "주문에서 아직 취소·환불하지 않은 정수 수량만 입력해 주세요.",
            "Enter only a whole quantity not yet canceled or refunded from the order.",
          ),
        );
      const amount = action.quantity * state.unitPrice;
      if (amount > simulationBalance(state))
        reject(
          "REFUND_EXCEEDS_BALANCE",
          t(
            "선택 수량의 가상 환불금액이 남은 환불 가능 금액을 초과합니다.",
            "The virtual refund for the selected quantity exceeds the remaining refundable amount.",
          ),
        );
      next = {
        ...state,
        refundedItemQuantity: state.refundedItemQuantity + action.quantity,
        refundedAmount: state.refundedAmount + amount,
        ...(action.type === "cancel-unshipped"
          ? {
              stock: state.stock + action.quantity,
              unshippedCanceled: state.unshippedCanceled + action.quantity,
            }
          : {}),
      };
      message =
        action.type === "cancel-unshipped"
          ? t(
              `모의 미출고 취소 완료: ${action.quantity}개 복원 · 테스트 재고 ${state.stock} → ${next.stock}개`,
              `Mock unshipped cancel done: ${action.quantity} restored · Test stock ${state.stock} → ${next.stock}`,
            )
          : t(
              `모의 출고 환불 완료: 가상금액 ${amount.toLocaleString("ko-KR")}원 환불 · 테스트 재고 ${state.stock}개 유지 (재입고 없음)`,
              `Mock shipped refund done: Virtual KRW ${amount.toLocaleString("en-US")} refunded · Test stock stays ${state.stock} (no restock)`,
            );
      break;
    }
    case "compensate":
      if (!positiveInteger(action.amount, simulationBalance(state)))
        reject(
          "REFUND_EXCEEDS_BALANCE",
          t(
            "남은 환불 가능 금액 안에서 양의 정수 가상금액을 입력해 주세요.",
            "Enter a positive whole virtual amount within the remaining refundable amount.",
          ),
        );
      next = { ...state, refundedAmount: state.refundedAmount + action.amount };
      message = t(
        `모의 보상 환불 완료: 테스트 재고 ${state.stock}개 유지 (재입고 없음)`,
        `Mock compensation refund done: Test stock stays ${state.stock} (no restock)`,
      );
      break;
    case "receive-return": {
      if (state.fulfillment !== "SHIPPED")
        reject(
          "SHIPMENT_REQUIRED",
          t(
            "반품 검수는 모의 출고 확인된 주문에만 가능합니다.",
            "Return inspection is only for orders with mock shipment confirmed.",
          ),
        );
      if (action.resalableConfirmed !== true)
        reject(
          "INSPECTION_REQUIRED",
          t(
            "실물 입고·검수 및 재판매 가능한 수량이라는 모의 확인이 필요합니다.",
            "A mock confirmation that the items were received, inspected and are resalable is required.",
          ),
        );
      if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(receipt))
        reject(
          "RECEIPT_INVALID",
          t(
            "모의 접수번호는 영문·숫자·하이픈 3~40자로 입력해 주세요.",
            "Enter the mock receipt number in 3–40 English letters, digits or hyphens.",
          ),
        );
      const previousReceipt = state.receipts.get(receipt);
      if (previousReceipt !== undefined) {
        if (previousReceipt !== action.quantity)
          reject(
            "RECEIPT_REUSED",
            t(
              "같은 검수 접수번호의 수량을 바꿀 수 없습니다.",
              "The quantity for the same inspection receipt number cannot change.",
            ),
          );
        return {
          state,
          message: t(
            "같은 모의 검수 접수번호는 이미 처리됐습니다. 다시 재입고하지 않았습니다.",
            "The same mock inspection receipt number was already processed. Nothing was restocked again.",
          ),
          replayed: true,
        };
      }
      if (
        !positiveInteger(
          action.quantity,
          state.shippedQuantity - state.returnedResalable,
        )
      )
        reject(
          "RETURN_EXCEEDS_SHIPPED",
          t(
            "출고 수량에서 이미 재입고한 수량을 제외한 정수 수량만 입력해 주세요.",
            "Enter only a whole quantity within the shipped quantity minus what was already restocked.",
          ),
        );
      next = {
        ...state,
        stock: state.stock + action.quantity,
        returnedResalable: state.returnedResalable + action.quantity,
        receipts: new Map([...state.receipts, [receipt, action.quantity]]),
      };
      message = t(
        `모의 검수 재입고 완료: ${action.quantity}개 복원 · 테스트 재고 ${state.stock} → ${next.stock}개`,
        `Mock inspection restock done: ${action.quantity} restored · Test stock ${state.stock} → ${next.stock}`,
      );
      break;
    }
    default:
      reject(
        "ACTION_INVALID",
        t("지원하지 않는 모의 동작입니다.", "This mock action is not supported."),
      );
  }
  if (
    next.stock !==
      10 -
        (next.paid ? next.orderedQuantity : 0) +
        next.unshippedCanceled +
        next.returnedResalable ||
    next.stock < 0 ||
    next.stock > 10 ||
    next.refundedAmount > 20_000 ||
    next.unshippedCanceled + next.returnedResalable > next.orderedQuantity
  )
    reject(
      "SIMULATION_INVARIANT",
      t(
        "모의 계산 오류입니다. 초기화 후 다시 체험해 주세요.",
        "Mock calculation error. Reset and try again.",
      ),
    );
  return {
    state: {
      ...next,
      operations: new Map([...state.operations, [action.operationId, fingerprint]]),
      history: [...state.history, message].slice(-30),
    },
    message,
    replayed: false,
  };
}
