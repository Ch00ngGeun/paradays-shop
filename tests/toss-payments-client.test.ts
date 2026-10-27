// 역할: Toss Payments 브라우저 adapter가 공개 client key만 허용하고 redirect URL에 일회성 주문 반환 토큰만 넣는지 검증합니다.
import { describe, expect, it, vi } from "vitest";

import {
  createTossPaymentReturnUrl,
  getTossPaymentsClientConfig,
  TossPaymentsClientUnavailableError,
  requestTossPayment,
} from "@/lib/commerce/toss-payments-client";

describe("getTossPaymentsClientConfig", () => {
  it("normal server-issued orders still use the unchanged authenticated CARD payment window contract", async () => {
    const requestPayment = vi.fn(async () => {});
    const factory = vi.fn(() => ({ payment: () => ({ requestPayment }) }));
    const loadSdk = vi.fn(async () => factory);
    await requestTossPayment({
      config: { clientKey: "test_ck_fake" },
      session: {
        orderId: "pd_normal_order",
        orderName: "Deck",
        amount: 20000,
        currency: "KRW",
        customerKey: "pd_customer",
        checkoutReturnToken: "a".repeat(43),
      },
      origin: "https://shop.example.com",
      loadSdk,
    });
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("test_ck_fake");
    expect(requestPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "CARD",
        orderId: "pd_normal_order",
        amount: { currency: "KRW", value: 20000 },
      }),
    );
  });
  it("TEST synthetic orders cannot load the payment SDK or request payment", async () => {
    const loadSdk = vi.fn();
    await expect(
      requestTossPayment({
        config: { clientKey: "test_ck_fake" },
        session: {
          orderId: "TEST_synthetic",
          orderName: "Synthetic",
          amount: 20000,
          currency: "KRW",
          customerKey: "synthetic",
          checkoutReturnToken: "synthetic",
        },
        origin: "https://shop.example.com",
        loadSdk,
      }),
    ).rejects.toThrow(TossPaymentsClientUnavailableError);
    expect(loadSdk).not.toHaveBeenCalled();
  });
  it("cannot insert a TEST order by mutating the caller session during SDK loading", async () => {
    const session = {
      orderId: "pd_original_order",
      orderName: "Deck",
      amount: 20000,
      currency: "KRW" as const,
      customerKey: "pd_customer",
      checkoutReturnToken: "a".repeat(43),
    };
    const requestPayment = vi.fn(async () => {});
    await requestTossPayment({
      config: { clientKey: "test_ck_fake" },
      session,
      origin: "https://shop.example.com",
      loadSdk: async () => {
        session.orderId = "TEST_inserted_during_load";
        session.amount = 1;
        return () => ({ payment: () => ({ requestPayment }) });
      },
    });
    expect(requestPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "pd_original_order",
        amount: { currency: "KRW", value: 20000 },
      }),
    );
  });
  it("공개 client key가 없으면 결제창 로드를 막음", () => {
    expect(() => getTossPaymentsClientConfig({})).toThrow(
      TossPaymentsClientUnavailableError,
    );
  });

  it("server secret처럼 보이는 값은 읽지 않고 제공된 public client key만 반환함", () => {
    expect(
      getTossPaymentsClientConfig({
        NEXT_PUBLIC_TOSS_CLIENT_KEY: "test_ck_public_value",
      }),
    ).toEqual({ clientKey: "test_ck_public_value" });
  });
});

describe("createTossPaymentReturnUrl", () => {
  it("성공 redirect를 Cart route로 보내고 checkout 반환 토큰만 포함함", () => {
    const url = new URL(
      createTossPaymentReturnUrl({
        origin: "https://shop.example.com",
        result: "success",
        checkoutReturnToken: "0123456789abcdef0123456789abcdef0123456789a",
      }),
    );

    expect(url.origin).toBe("https://shop.example.com");
    expect(url.pathname).toBe("/cart");
    expect(url.searchParams.get("payment")).toBe("success");
    expect(url.searchParams.get("checkoutToken")).toBe(
      "0123456789abcdef0123456789abcdef0123456789a",
    );
    expect(url.searchParams.get("secretKey")).toBeNull();
  });
});
