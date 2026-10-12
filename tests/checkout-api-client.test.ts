// 역할: 공개 checkout API 클라이언트가 가격을 보내지 않고 Cognito 토큰·멱등성 키·Toss redirect 반환 토큰을 안전하게 전달하는지 검증합니다.
import { describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_API_BASE_URL_ENV,
  CheckoutClientUnavailableError,
  createCheckoutApiClient,
  createCheckoutSessionPayload,
  getCheckoutApiConfig,
  type StartCheckoutInput,
} from "@/lib/commerce/checkout-api-client";

const checkoutInput: StartCheckoutInput = {
  addressId: "address-42",
  lines: [
    {
      productId: "pradays-image-deck-8-25",
      quantity: 2,
      selectedSize: "8.25\”",
    },
  ],
};

describe("getCheckoutApiConfig", () => {
  it("공개 API 환경변수가 없으면 명확한 결제 불가 오류를 반환함", () => {
    expect(() => getCheckoutApiConfig({})).toThrow(CheckoutClientUnavailableError);
    expect(() => getCheckoutApiConfig({})).toThrow(CHECKOUT_API_BASE_URL_ENV);
  });

  it("API Gateway stage path를 유지하는 공개 URL만 설정으로 허용함", () => {
    expect(
      getCheckoutApiConfig({
        NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.example.com/prod/",
      }),
    ).toEqual({ apiBaseUrl: "https://api.example.com/prod" });
  });
});

describe("createCheckoutSessionPayload", () => {
  it("신뢰할 수 없는 추가 가격 필드를 API 요청 본문에서 제거함", () => {
    const untrustedInput = {
      ...checkoutInput,
      lines: [
        {
          ...checkoutInput.lines[0],
          price: 1,
          unitPrice: 1,
          total: 1,
        },
      ],
    } as unknown as StartCheckoutInput;

    expect(createCheckoutSessionPayload(untrustedInput)).toEqual(checkoutInput);
  });
});

describe("createCheckoutApiClient", () => {
  it("Cognito access token과 호출 단위 멱등성 키를 헤더로 주입하고 가격 없이 세션을 요청함", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderId: "pd_test_order_20260920_0001",
          orderName: "PRADAYS Image Deck",
          amount: 216000,
          currency: "KRW",
          customerKey: "pd_customer_key_20260920",
          checkoutReturnToken: "0123456789abcdef0123456789abcdef0123456789a",
        }),
        { status: 201 },
      ),
    );
    const client = createCheckoutApiClient({
      config: getCheckoutApiConfig({
        NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.example.com/prod",
      }),
      authorizationTokenProvider: {
        getAccessToken: () => "cognito-access-token",
      },
      fetchImplementation,
      idempotencyKeyFactory: () => "checkout-test-request-0001",
    });
    const untrustedInput = {
      ...checkoutInput,
      lines: [{ ...checkoutInput.lines[0], price: 1 }],
    } as unknown as StartCheckoutInput;

    await expect(client.createSession(untrustedInput)).resolves.toEqual({
      orderId: "pd_test_order_20260920_0001",
      orderName: "PRADAYS Image Deck",
      amount: 216000,
      currency: "KRW",
      customerKey: "pd_customer_key_20260920",
      checkoutReturnToken: "0123456789abcdef0123456789abcdef0123456789a",
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImplementation.mock.calls[0];
    const requestHeaders = new Headers(request?.headers);

    expect(url).toBe("https://api.example.com/prod/checkout/sessions");
    expect(request).toMatchObject({ method: "POST" });
    expect(requestHeaders.get("authorization")).toBe("Bearer cognito-access-token");
    expect(requestHeaders.get("x-idempotency-key")).toBe("checkout-test-request-0001");
    expect(JSON.parse(String(request?.body))).toEqual(checkoutInput);
  });

  it("Toss redirect 성공값은 반환 토큰과 함께 별도 confirmation endpoint로 보내고 bearer token을 재사용하지 않음", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderId: "pd_test_order_20260920_0001",
          status: "PAID",
          paymentStatus: "DONE",
        }),
        { status: 200 },
      ),
    );
    const client = createCheckoutApiClient({
      config: getCheckoutApiConfig({
        NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.example.com/prod",
      }),
      authorizationTokenProvider: {
        getAccessToken: () => "cognito-access-token",
      },
      fetchImplementation,
    });

    await expect(
      client.confirmPayment({
        paymentKey: "payment-key-20260920",
        orderId: "pd_test_order_20260920_0001",
        amount: 216000,
        checkoutReturnToken: "0123456789abcdef0123456789abcdef0123456789a",
      }),
    ).resolves.toEqual({
      orderId: "pd_test_order_20260920_0001",
      status: "PAID",
      paymentStatus: "DONE",
    });

    const [url, request] = fetchImplementation.mock.calls[0];
    const requestHeaders = new Headers(request?.headers);

    expect(url).toBe("https://api.example.com/prod/payments/confirm");
    expect(request).toMatchObject({ method: "POST" });
    expect(requestHeaders.get("authorization")).toBeNull();
    expect(JSON.parse(String(request?.body))).toEqual({
      paymentKey: "payment-key-20260920",
      orderId: "pd_test_order_20260920_0001",
      amount: 216000,
      checkoutReturnToken: "0123456789abcdef0123456789abcdef0123456789a",
    });
  });
});
