/** One invocation-wide budget; late SDK completion cannot start a subsequent write. */
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
/** Outside a sales request, shared admin/inventory callers keep their original SDK behavior. */
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
/** budgetMs is server-controlled/test-only; it is never read from an HTTP event. */
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
    // Stop a still-running sibling when a complete read fails closed.
    budget.controller.abort();
  }
}
