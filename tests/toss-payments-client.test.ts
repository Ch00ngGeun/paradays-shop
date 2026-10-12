// 역할: Toss Payments 브라우저 adapter가 공개 client key만 허용하고 redirect URL에 일회성 주문 반환 토큰만 넣는지 검증합니다.
import { describe, expect, it } from "vitest";

import {
  createTossPaymentReturnUrl,
  getTossPaymentsClientConfig,
  TossPaymentsClientUnavailableError,
} from "@/lib/commerce/toss-payments-client";

describe("getTossPaymentsClientConfig", () => {
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
