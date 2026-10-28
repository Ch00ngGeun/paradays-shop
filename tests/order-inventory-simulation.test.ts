import { describe, it, expect } from "vitest";
import {
  applySimulation,
  createSimulation,
  simulationBalance,
  type SimulationAction,
  type SimulationState,
} from "@/lib/admin-ui/order-inventory-simulation";
const act = (
  state: SimulationState,
  action: Omit<SimulationAction, "operationId">,
  id = "operation",
) => applySimulation(state, { ...action, operationId: id } as SimulationAction).state;
const approved = () => act(createSimulation("unit-session"), { type: "approve" });
const fulfill = (state: SimulationState, fulfillment: "UNSHIPPED" | "SHIPPED") =>
  act(
    state,
    { type: "fulfillment", state: fulfillment } as Omit<
      SimulationAction,
      "operationId"
    >,
    `fulfill-${fulfillment}`,
  );
describe("isolated synthetic order calculator", () => {
  it("creates only TEST identity, fixed synthetic data and no automatic approval", () => {
    const s = createSimulation("session-1");
    expect(s.orderId).toBe("TEST_session-1");
    expect(s.productId).toBe("TEST_PRODUCT_DECK");
    expect(s.stock).toBe(10);
    expect(s.paid).toBe(false);
    expect(simulationBalance(s)).toBe(20_000);
  });
  it("approval10→8 and unshipped partial cancel1→9, then cumulative total≤2", () => {
    let s = fulfill(approved(), "UNSHIPPED");
    s = act(
      s,
      { type: "cancel-unshipped", quantity: 1 } as Omit<
        SimulationAction,
        "operationId"
      >,
      "cancel-1",
    );
    expect(s.stock).toBe(9);
    s = act(
      s,
      { type: "cancel-unshipped", quantity: 1 } as Omit<
        SimulationAction,
        "operationId"
      >,
      "cancel-2",
    );
    expect(s.stock).toBe(10);
    expect(() =>
      act(
        s,
        { type: "cancel-unshipped", quantity: 1 } as Omit<
          SimulationAction,
          "operationId"
        >,
        "cancel-3",
      ),
    ).toThrow();
  });
  it("shipped refund leaves8; inspected return1→9; same receipt with new op never adds twice", () => {
    let s = fulfill(approved(), "SHIPPED");
    s = act(
      s,
      { type: "refund-shipped", quantity: 2 } as Omit<SimulationAction, "operationId">,
      "refund",
    );
    expect(s.stock).toBe(8);
    const action = {
      type: "receive-return",
      quantity: 1,
      receiptId: "TEST-RMA-1",
      resalableConfirmed: true,
    } as Omit<SimulationAction, "operationId">;
    s = act(s, action, "return-1");
    expect(s.stock).toBe(9);
    expect(act(s, action, "return-2")).toBe(s);
    expect(() =>
      act(
        s,
        { ...action, quantity: 2 } as Omit<SimulationAction, "operationId">,
        "return-3",
      ),
    ).toThrow();
  });
  it("partially canceled then shipped order only allows the actually shipped remainder to return", () => {
    let s = fulfill(approved(), "UNSHIPPED");
    s = act(
      s,
      { type: "cancel-unshipped", quantity: 1 } as Omit<
        SimulationAction,
        "operationId"
      >,
      "cancel",
    );
    s = fulfill(s, "SHIPPED");
    expect(s.shippedQuantity).toBe(1);
    expect(() =>
      act(
        s,
        {
          type: "receive-return",
          quantity: 2,
          receiptId: "TEST-RMA",
          resalableConfirmed: true,
        } as Omit<SimulationAction, "operationId">,
        "return",
      ),
    ).toThrow();
  });
  it("compensation changes virtual money only and enforces remaining refund balance", () => {
    let s = fulfill(approved(), "UNSHIPPED");
    s = act(
      s,
      { type: "compensate", amount: 15_000 } as Omit<SimulationAction, "operationId">,
      "compensate",
    );
    expect(s.stock).toBe(8);
    expect(simulationBalance(s)).toBe(5000);
    expect(() =>
      act(
        s,
        { type: "cancel-unshipped", quantity: 1 } as Omit<
          SimulationAction,
          "operationId"
        >,
        "cancel",
      ),
    ).toThrow();
    s = act(
      s,
      { type: "compensate", amount: 5000 } as Omit<SimulationAction, "operationId">,
      "compensate-2",
    );
    expect(s.stock).toBe(8);
    expect(() => fulfill(s, "SHIPPED")).toThrow();
  });
  it("rejects shipment reversal, uninspected goods and excessive/invalid quantities", () => {
    const shipped = fulfill(approved(), "SHIPPED");
    expect(() => fulfill(shipped, "UNSHIPPED")).toThrow();
    for (const quantity of [0, -1, 1.5, NaN, Infinity, 3])
      expect(() =>
        act(
          shipped,
          {
            type: "receive-return",
            quantity,
            receiptId: "TEST-RMA",
            resalableConfirmed: true,
          } as Omit<SimulationAction, "operationId">,
          "return",
        ),
      ).toThrow();
    expect(() =>
      act(
        shipped,
        {
          type: "receive-return",
          quantity: 1,
          receiptId: "TEST-RMA",
          resalableConfirmed: false,
        } as Omit<SimulationAction, "operationId">,
        "return",
      ),
    ).toThrow();
  });
  it("repeat approvals/double click are idempotent and same operation cannot be retargeted", () => {
    const s = approved();
    expect(act(s, { type: "approve" })).toBe(s);
    expect(act(s, { type: "approve" }, "new-op")).toBe(s);
    expect(() =>
      act(s, { type: "compensate", amount: 1 } as Omit<
        SimulationAction,
        "operationId"
      >),
    ).toThrow();
  });
  it("initialization is fresh memory without retained receipts, quantities or operation IDs", () => {
    const first = approved();
    const reset = createSimulation("reset");
    expect(reset.stock).toBe(10);
    expect(reset.orderId).not.toBe(first.orderId);
    expect(reset.operations.size).toBe(0);
    expect(reset.receipts.size).toBe(0);
    expect(first.stock).toBe(8);
  });
});
