/** 역할: 매출 요청 하나에 호출 전체 시간 예산과 AbortSignal을 두어, 늦게 끝난 SDK 호출이 이어지는 쓰기를 시작하지 못하게 함. */
import { AsyncLocalStorage } from "node:async_hooks";
import { SalesError } from "./sales-ledger-domain.js";

export const SALES_REQUEST_BUDGET_MS = 24_000;
type Budget = { deadline: number; controller: AbortController };
const requests = new AsyncLocalStorage<Budget>();

function expired(budget: Budget): boolean {
  return budget.controller.signal.aborted || Date.now() >= budget.deadline;
}
function deadlineError() {
  return new SalesError("SALES_REQUEST_DEADLINE_EXCEEDED", 503);
}
/** 매출 요청 밖에서는 공용 관리자·재고 호출부가 원래 SDK 동작을 유지함. */
export function salesRequestSignal(): AbortSignal | undefined {
  const budget = requests.getStore();
  if (!budget) return undefined;
  if (expired(budget)) throw deadlineError();
  return budget.controller.signal;
}
export function salesRequestDeadline(localDeadline: number): number {
  const budget = requests.getStore();
  if (!budget) return localDeadline;
  if (expired(budget)) throw deadlineError();
  return Math.min(localDeadline, budget.deadline);
}
/** budgetMs는 서버나 테스트만 정하며 HTTP event에서 읽지 않음. */
export async function withSalesRequest<T>(
  operation: () => Promise<T>,
  budgetMs = SALES_REQUEST_BUDGET_MS,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw deadlineError();
  const budget: Budget = {
    deadline: Date.now() + Math.min(budgetMs, SALES_REQUEST_BUDGET_MS),
    controller: new AbortController(),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        budget.controller.abort();
        reject(deadlineError());
      },
      Math.min(budgetMs, SALES_REQUEST_BUDGET_MS),
    );
    timer.unref();
  });
  try {
    return await requests.run(budget, async () => {
      const result = await Promise.race([operation(), timeout]);
      if (expired(budget)) throw deadlineError();
      return result;
    });
  } finally {
    if (timer) clearTimeout(timer);
    // 전체 읽기가 fail-closed로 실패하면 아직 실행 중인 형제 작업도 멈춤.
    budget.controller.abort();
  }
}
