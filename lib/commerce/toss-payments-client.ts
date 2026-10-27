// 역할: Toss Payments V2 결제창 SDK를 공개 client key로만 로드하고, 서버가 만든 주문 정보로 결제 인증을 시작합니다.
import type { CheckoutSession } from "@/lib/commerce/checkout-api-client";
import { isSyntheticIdentifier } from "./synthetic-identifiers";

/** Toss Payments V2 표준 JavaScript SDK 주소입니다. */
const TOSS_PAYMENTS_SDK_URL = "https://js.tosspayments.com/v2/standard";

/** 브라우저에 노출해도 되는 Toss Payments client key 환경변수 이름입니다. */
export const TOSS_PAYMENTS_CLIENT_KEY_ENV = "NEXT_PUBLIC_TOSS_CLIENT_KEY";

/** Next.js 빌드에 주입되는 Toss Payments 공개 설정의 테스트 가능한 형태입니다. */
export type TossPaymentsPublicEnvironment = Readonly<{
  NEXT_PUBLIC_TOSS_CLIENT_KEY?: string;
}>;

/** 결제창 SDK 초기화에 필요한 공개 client key입니다. */
export type TossPaymentsClientConfig = Readonly<{
  clientKey: string;
}>;

/** V2 Payment Window에 넘기는 최소 결제 요청 형식입니다. */
export type TossPaymentRequest = Readonly<{
  method: "CARD";
  amount: Readonly<{ currency: "KRW"; value: number }>;
  orderId: string;
  orderName: string;
  successUrl: string;
  failUrl: string;
  customerEmail?: string;
}>;

/** Toss V2 SDK가 브라우저 전역에 제공하는 객체의 필요한 부분만 정의합니다. */
type TossPaymentWindow = Readonly<{
  requestPayment: (request: TossPaymentRequest) => Promise<unknown>;
}>;

/** Toss V2 SDK factory의 필요한 부분만 정의합니다. */
type TossPaymentsFactory = (clientKey: string) => Readonly<{
  payment: (options: Readonly<{ customerKey: string }>) => TossPaymentWindow;
}>;

/** 결제창 스크립트·공개 키가 준비되지 않은 경우를 UI가 구분하도록 하는 오류입니다. */
export class TossPaymentsClientUnavailableError extends Error {
  readonly code = "TOSS_PAYMENTS_CLIENT_UNAVAILABLE";

  constructor(reason: string) {
    super(`TOSS_PAYMENTS_CLIENT_UNAVAILABLE: ${reason}`);
    this.name = "TossPaymentsClientUnavailableError";
  }
}

/** Toss Payments 결제 요청을 시작하지 못한 경우 공개 가능한 원인만 담는 오류입니다. */
export class TossPaymentsRequestError extends Error {
  readonly code = "TOSS_PAYMENTS_REQUEST_FAILED";

  constructor() {
    super("TOSS_PAYMENTS_REQUEST_FAILED: Unable to start the payment window.");
    this.name = "TossPaymentsRequestError";
  }
}

/** 브라우저 번들에는 client key만 읽고 server secret은 어떤 경로로도 읽지 않습니다. */
export function readTossPaymentsPublicEnvironment(): TossPaymentsPublicEnvironment {
  return {
    NEXT_PUBLIC_TOSS_CLIENT_KEY: process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY,
  };
}

/** 공개 client key를 검증해 키 미발급 상태에서 결제창 로드를 시도하지 않게 합니다. */
export function getTossPaymentsClientConfig(
  environment: TossPaymentsPublicEnvironment = readTossPaymentsPublicEnvironment(),
): TossPaymentsClientConfig {
  const clientKey = environment.NEXT_PUBLIC_TOSS_CLIENT_KEY?.trim();

  if (!clientKey) {
    throw new TossPaymentsClientUnavailableError(
      `${TOSS_PAYMENTS_CLIENT_KEY_ENV} must be configured before payment can start.`,
    );
  }

  if (/\s/.test(clientKey) || clientKey.length > 300) {
    throw new TossPaymentsClientUnavailableError(
      `${TOSS_PAYMENTS_CLIENT_KEY_ENV} has an invalid value.`,
    );
  }

  return { clientKey };
}

/** Toss redirect를 Cart 라우트로 되돌리되, 일회성 주문 반환 토큰만 별도 쿼리로 보냅니다. */
export function createTossPaymentReturnUrl({
  origin,
  result,
  checkoutReturnToken,
}: Readonly<{
  origin: string;
  result: "success" | "fail";
  checkoutReturnToken: string;
}>) {
  let url: URL;

  try {
    url = new URL("/cart", origin);
  } catch {
    throw new TossPaymentsClientUnavailableError(
      "A valid storefront origin is required.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TossPaymentsClientUnavailableError(
      "A HTTP(S) storefront origin is required.",
    );
  }

  url.searchParams.set("payment", result);
  url.searchParams.set("checkoutToken", checkoutReturnToken);

  return url.toString();
}

/** V2 SDK를 한 번만 동적으로 로드해 정적 export에서도 결제 전용 코드만 내려받게 합니다. */
export async function loadTossPaymentsSdk(
  documentReference: Document = document,
): Promise<TossPaymentsFactory> {
  const existingFactory = getTossPaymentsFactory(documentReference.defaultView);

  if (existingFactory) {
    return existingFactory;
  }

  const existingScript = documentReference.querySelector<HTMLScriptElement>(
    'script[data-toss-payments-sdk="v2"]',
  );

  await new Promise<void>((resolve, reject) => {
    const script = existingScript ?? documentReference.createElement("script");

    const complete = () => {
      const factory = getTossPaymentsFactory(documentReference.defaultView);

      if (factory) {
        resolve();
      } else {
        reject(
          new TossPaymentsClientUnavailableError(
            "The Toss Payments SDK did not initialize.",
          ),
        );
      }
    };

    script.addEventListener("load", complete, { once: true });
    script.addEventListener(
      "error",
      () =>
        reject(
          new TossPaymentsClientUnavailableError(
            "The Toss Payments SDK could not load.",
          ),
        ),
      { once: true },
    );

    if (!existingScript) {
      script.async = true;
      script.dataset.tossPaymentsSdk = "v2";
      script.src = TOSS_PAYMENTS_SDK_URL;
      documentReference.head.append(script);
    }
  });

  const factory = getTossPaymentsFactory(documentReference.defaultView);

  if (!factory) {
    throw new TossPaymentsClientUnavailableError(
      "The Toss Payments SDK did not initialize.",
    );
  }

  return factory;
}

/** 서버가 만든 주문 정보만 Toss SDK에 전달해 결제 인증 redirect를 시작합니다. */
export async function requestTossPayment({
  config,
  session,
  origin,
  customerEmail,
  loadSdk = loadTossPaymentsSdk,
}: Readonly<{
  config: TossPaymentsClientConfig;
  session: CheckoutSession;
  origin: string;
  customerEmail?: string;
  loadSdk?: () => Promise<TossPaymentsFactory>;
}>): Promise<void> {
  // Own the validated values before SDK loading yields to other browser code.
  const paymentSession = { ...session };
  if (isSyntheticIdentifier(paymentSession.orderId))
    throw new TossPaymentsClientUnavailableError(
      "Synthetic TEST orders cannot open a real payment window.",
    );
  const successUrl = createTossPaymentReturnUrl({
    origin,
    result: "success",
    checkoutReturnToken: paymentSession.checkoutReturnToken,
  });
  const failUrl = createTossPaymentReturnUrl({
    origin,
    result: "fail",
    checkoutReturnToken: paymentSession.checkoutReturnToken,
  });

  try {
    const tossPayments = (await loadSdk())(config.clientKey);
    const payment = tossPayments.payment({ customerKey: paymentSession.customerKey });

    await payment.requestPayment({
      method: "CARD",
      amount: { currency: paymentSession.currency, value: paymentSession.amount },
      orderId: paymentSession.orderId,
      orderName: paymentSession.orderName,
      successUrl,
      failUrl,
      ...(customerEmail ? { customerEmail } : {}),
    });
  } catch (error) {
    if (error instanceof TossPaymentsClientUnavailableError) {
      throw error;
    }

    throw new TossPaymentsRequestError();
  }
}

/** window 전역을 좁은 SDK factory 타입으로 확인해 외부 스크립트 값에 직접 의존하지 않습니다. */
function getTossPaymentsFactory(windowReference: Window | null | undefined) {
  const candidate = (windowReference as unknown as { TossPayments?: unknown } | null)
    ?.TossPayments;

  return typeof candidate === "function" ? (candidate as TossPaymentsFactory) : null;
}
