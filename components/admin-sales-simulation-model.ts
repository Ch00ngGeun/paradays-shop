// 역할: 모의 매출·일마감 연습 화면들이 쓰는 결제 구분 이름, 전표 편집 상태 타입과 빈 전표·기존 전표·테스트 상품 줄 생성, 입력값을 모의 전표 입력으로 바꾸는 함수를 둡니다.
import {
  TEST_SALES_PRODUCTS,
  TestSalesError,
  type TestProductId,
  type TestSaleEntry,
  type TestSaleInput,
} from "@/lib/admin-ui/sales-ledger-simulation";
import type { Locale } from "@/types/store";

export const methodLabels = {
  ko: { CARD: "카드", CASH: "현금", TRANSFER: "이체" },
  en: { CARD: "Card", CASH: "Cash", TRANSFER: "Transfer" },
};
export type Notice = string | Readonly<Record<Locale, string>>;
export type Editor = {
  id?: string;
  version?: number;
  time: string;
  method: TestSaleInput["method"];
  reference: string;
  amount: string;
  lines: {
    productId: TestProductId;
    option: string;
    quantity: string;
    unitAmount: string;
  }[];
};
export const money = (n: number, locale: Locale = "ko") =>
  locale === "ko"
    ? `${n.toLocaleString("ko-KR")}원`
    : `KRW ${n.toLocaleString("en-US")}`;
export const blank = (): Editor => ({
  time: "09:00",
  method: "CARD",
  reference: "TEST_CARD_001",
  amount: "",
  lines: [],
});
export const editorOf = (e: TestSaleEntry): Editor => ({
  ...e,
  lines: e.lines.map((line) => ({
    ...line,
    quantity: String(line.quantity),
    unitAmount: String(line.unitAmount),
  })),
  amount: String(e.amount),
});
export const rowOf = (id: TestProductId) => {
  const product = TEST_SALES_PRODUCTS.find((p) => p.id === id)!;
  return {
    productId: id,
    option: product.options[0],
    quantity: "1",
    unitAmount: String(product.unitAmount),
  };
};
export function inputOf(editor: Editor): TestSaleInput {
  if (
    !editor.amount.trim() ||
    editor.lines.some((line) => !line.quantity.trim() || !line.unitAmount.trim())
  )
    throw new TestSalesError({
      ko: "가상 금액·상품 수량·단가를 입력해 주세요.",
      en: "Enter the virtual amount, product quantities and unit prices.",
    });
  return {
    time: editor.time,
    method: editor.method,
    reference: editor.reference,
    amount: Number(editor.amount),
    lines: editor.lines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      unitAmount: Number(line.unitAmount),
    })),
  };
}
