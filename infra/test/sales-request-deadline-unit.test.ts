import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  salesRequestDeadline,
  salesRequestSignal,
  withSalesRequest,
} from "../lambda/sales-request-deadline.js";

const deadlineExceeded = { code: "SALES_REQUEST_DEADLINE_EXCEEDED" };

test("callers outside a sales request keep their own deadline and no signal", () => {
  assert.equal(salesRequestSignal(), undefined);
  assert.equal(salesRequestDeadline(123), 123);
});

test("inside a request the budget caps the local deadline and exposes a live signal", async () => {
  const far = Date.now() + 60_000;
  await withSalesRequest(async () => {
    assert.ok(salesRequestDeadline(far) < far);
    assert.equal(salesRequestSignal()?.aborted, false);
  }, 1_000);
});

test("a stalled operation fails closed and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    withSalesRequest(async () => {
      signal = salesRequestSignal();
      await delay(200);
    }, 20),
    deadlineExceeded,
  );
  assert.equal(signal?.aborted, true);
});

test("a non-positive or non-finite budget is rejected before running", async () => {
  let ran = false;
  for (const budget of [0, -1, Number.NaN])
    await assert.rejects(
      withSalesRequest(async () => {
        ran = true;
      }, budget),
      deadlineExceeded,
    );
  assert.equal(ran, false);
});
