// 역할: 정적 스토어프론트가 Cognito 인증 API Gateway를 통해 주문을 만들고 Toss 결제 승인을 요청하는 공개 API 계약을 제공합니다.
import type { CheckoutRequestLine } from "@/lib/commerce/checkout-domain";
import { isSyntheticIdentifier } from "./synthetic-identifiers";

/** 브라우저 번들에 넣어도 되는 API Gateway 기본 URL 환경변수 이름입니다. */
export const CHECKOUT_API_BASE_URL_ENV = "NEXT_PUBLIC_COMMERCE_API_BASE_URL";

/** Next.js가 브라우저 번들에 공개하는 commerce API 설정만 표현합니다. */
export type CheckoutPublicEnvironment = Readonly<{
  NEXT_PUBLIC_COMMERCE_API_BASE_URL?: string;
}>;

/** 결제·회원 API가 공유하는 공개 API Gateway 설정입니다. */
export type CheckoutApiConfig = Readonly<{
  apiBaseUrl: string;
}>;

/** Cognito 같은 인증 계층이 주문 생성 요청에 주입할 access token 계약입니다. */
export type CheckoutAuthorizationTokenProvider = Readonly<{
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
}>;

/** 브라우저가 주문 생성 API에 보낼 최소 정보입니다. 가격·할인·결제 결과는 이 타입에 없습니다. */
export type StartCheckoutInput = Readonly<{
  lines: readonly CheckoutRequestLine[];
  addressId?: string;
}>;

/** API Gateway에 전송할 직렬화된 주문 생성 본문입니다. 멱등성 키는 헤더에만 넣습니다. */
export type CreateCheckoutSessionPayload = Readonly<{
  lines: CheckoutRequestLine[];
  addressId?: string;
}>;

/** 서버가 가격 검증 후 만든, Toss 결제창 호출 전용 주문 정보입니다. */
export type CheckoutSession = Readonly<{
  orderId: string;
  orderName: string;
  amount: number;
  currency: "KRW";
  customerKey: string;
  checkoutReturnToken: string;
}>;

/** Toss 성공 redirect 후 서버 결제 승인을 요청하는 최소 정보입니다. */
export type ConfirmPaymentInput = Readonly<{
  paymentKey: string;
  orderId: string;
  amount: number;
  checkoutReturnToken: string;
}>;

/** 서버가 저장한 주문 상태를 기준으로 반환하는 결제 승인 결과입니다. */
export type ConfirmedPayment = Readonly<{
  orderId: string;
  status: "PAID" | "PENDING_PAYMENT";
  paymentStatus: string;
}>;

/** 멱등성 키 생성기를 교체해 테스트와 호출 단위 재시도를 제어할 수 있게 합니다. */
export type CheckoutIdempotencyKeyFactory = () => string;

/** checkout API 클라이언트가 의존하는 외부 브라우저 기능을 명시적으로 주입합니다. */
export type CheckoutApiClientDependencies = Readonly<{
  config: CheckoutApiConfig;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  fetchImplementation?: typeof fetch;
  idempotencyKeyFactory?: CheckoutIdempotencyKeyFactory;
}>;

/** UI가 실제 주문 생성·결제 승인 API를 호출하는 최소 인터페이스입니다. */
export type CheckoutApiClient = Readonly<{
  createSession: (input: StartCheckoutInput) => Promise<CheckoutSession>;
  confirmPayment: (input: ConfirmPaymentInput) => Promise<ConfirmedPayment>;
}>;

/** 공개 환경변수나 브라우저 기능이 없을 때 UI가 결제 불가 상태를 명확히 처리하게 하는 오류입니다. */
export class CheckoutClientUnavailableError extends Error {
  readonly code = "CHECKOUT_CLIENT_UNAVAILABLE";

  constructor(reason: string) {
    super(`CHECKOUT_CLIENT_UNAVAILABLE: ${reason}`);
    this.name = "CheckoutClientUnavailableError";
  }
}

/** 로그인 토큰 없이 인증된 주문 생성 API를 요청하는 실수를 구분하는 오류입니다. */
export class CheckoutAuthorizationRequiredError extends Error {
  readonly code = "CHECKOUT_AUTHORIZATION_REQUIRED";

  constructor() {
    super("CHECKOUT_AUTHORIZATION_REQUIRED: Sign in is required before checkout.");
    this.name = "CheckoutAuthorizationRequiredError";
  }
}

/** API Gateway가 거절한 요청을 응답 본문·토큰 없이 UI에 전달하는 오류입니다. */
export class CheckoutApiRequestError extends Error {
  readonly code = "CHECKOUT_API_REQUEST_FAILED";

  constructor(
    readonly status: number,
    readonly endpoint: "session" | "confirmation",
  ) {
    super(`CHECKOUT_API_REQUEST_FAILED: ${endpoint} ${status}`);
    this.name = "CheckoutApiRequestError";
  }
}

/** API Gateway 응답이 공개 checkout 계약을 만족하지 않을 때 안전하게 중단하는 오류입니다. */
export class CheckoutApiResponseError extends Error {
  readonly code = "CHECKOUT_API_RESPONSE_INVALID";

  constructor() {
    super("CHECKOUT_API_RESPONSE_INVALID: Checkout API response is invalid.");
    this.name = "CheckoutApiResponseError";
  }
}

/** Next.js가 브라우저에 공개할 수 있는 환경변수만 직접 읽습니다. Toss 비밀키는 이 모듈에 존재하지 않습니다. */
export function readCheckoutPublicEnvironment(): CheckoutPublicEnvironment {
  return {
    NEXT_PUBLIC_COMMERCE_API_BASE_URL: process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL,
  };
}

/** 공개 API URL을 검증해 미설정·잘못된 배포 환경에서 결제 버튼이 애매하게 실패하지 않게 합니다. */
export function getCheckoutApiConfig(
  environment: CheckoutPublicEnvironment = readCheckoutPublicEnvironment(),
): CheckoutApiConfig {
  const rawApiBaseUrl = environment.NEXT_PUBLIC_COMMERCE_API_BASE_URL?.trim();

  if (!rawApiBaseUrl) {
    throw new CheckoutClientUnavailableError(
      `${CHECKOUT_API_BASE_URL_ENV} must be configured before checkout can start.`,
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawApiBaseUrl);
  } catch {
    throw new CheckoutClientUnavailableError(
      `${CHECKOUT_API_BASE_URL_ENV} must be a valid HTTP(S) URL.`,
    );
  }

  if (
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new CheckoutClientUnavailableError(
      `${CHECKOUT_API_BASE_URL_ENV} must be a plain HTTP(S) API base URL.`,
    );
  }

  return {
    apiBaseUrl: parsedUrl.toString().replace(/\/+$/, ""),
  };
}

/** crypto API로 재시도 충돌을 막는 호출 단위 멱등성 키를 생성합니다. */
export function createCheckoutIdempotencyKey(): string {
  const browserCrypto = globalThis.crypto;

  if (typeof browserCrypto?.randomUUID === "function") {
    return `checkout-${browserCrypto.randomUUID()}`;
  }

  if (typeof browserCrypto?.getRandomValues !== "function") {
    throw new CheckoutClientUnavailableError(
      "A secure browser crypto API is required to create a checkout idempotency key.",
    );
  }

  const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `checkout-${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

/** 외부 상태가 섞인 input을 순수한 API 계약으로 다시 만들며 가격 필드는 절대 전달하지 않습니다. */
export function createCheckoutSessionPayload(
  input: StartCheckoutInput,
): CreateCheckoutSessionPayload {
  if (input.lines.some((line) => isSyntheticIdentifier(line.productId)))
    throw new CheckoutApiResponseError();
  const addressId = input.addressId?.trim();

  return {
    lines: input.lines.map(({ productId, quantity, selectedSize }) => ({
      productId,
      quantity,
      selectedSize,
    })),
    ...(addressId ? { addressId } : {}),
  };
}

/** redirect query 값을 서버 확인 계약으로 좁혀 UI가 불필요한 값을 보내지 않게 합니다. */
export function createPaymentConfirmationPayload(
  input: ConfirmPaymentInput,
): ConfirmPaymentInput {
  const paymentKey = input.paymentKey.trim();
  const orderId = input.orderId.trim();
  const checkoutReturnToken = input.checkoutReturnToken.trim();

  if (
    !paymentKey ||
    !orderId ||
    isSyntheticIdentifier(orderId) ||
    !checkoutReturnToken ||
    !Number.isInteger(input.amount)
  ) {
    throw new CheckoutApiResponseError();
  }

  return { paymentKey, orderId, amount: input.amount, checkoutReturnToken };
}

/** 환경 설정과 Cognito 토큰 제공자를 연결한 checkout API 클라이언트를 만듭니다. */
export function createCheckoutApiClient(
  dependencies: CheckoutApiClientDependencies,
): CheckoutApiClient {
  const fetchImplementation = resolveFetchImplementation(
    dependencies.fetchImplementation,
  );
  const sessionUrl = buildApiUrl(dependencies.config.apiBaseUrl, "checkout/sessions");
  const confirmationUrl = buildApiUrl(
    dependencies.config.apiBaseUrl,
    "payments/confirm",
  );
  const idempotencyKeyFactory =
    dependencies.idempotencyKeyFactory ?? createCheckoutIdempotencyKey;

  return {
    async createSession(input) {
      // Freeze/validate the request before token refresh; TEST data can never be inserted during an await.
      const payload = createCheckoutSessionPayload(input);
      const accessToken = await getAccessToken(dependencies.authorizationTokenProvider);
      const idempotencyKey = getValidIdempotencyKey(idempotencyKeyFactory());
      const response = await fetchImplementation(sessionUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new CheckoutApiRequestError(response.status, "session");
      }

      return parseCheckoutSession(await readJsonResponse(response));
    },
    async confirmPayment(input) {
      const response = await fetchImplementation(confirmationUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createPaymentConfirmationPayload(input)),
      });

      if (!response.ok) {
        throw new CheckoutApiRequestError(response.status, "confirmation");
      }

      return parseConfirmedPayment(await readJsonResponse(response));
    },
  };
}

/** 환경변수 기반 구성을 쓰되, 테스트에서는 명시적인 환경 객체를 전달할 수 있게 합니다. */
export function createCheckoutApiClientFromEnvironment(
  dependencies: Omit<CheckoutApiClientDependencies, "config">,
  environment: CheckoutPublicEnvironment = readCheckoutPublicEnvironment(),
): CheckoutApiClient {
  return createCheckoutApiClient({
    ...dependencies,
    config: getCheckoutApiConfig(environment),
  });
}

/** API Gateway stage path를 보존하면서 경로를 조합합니다. */
function buildApiUrl(apiBaseUrl: string, path: string) {
  try {
    return new URL(path, `${apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    throw new CheckoutClientUnavailableError(
      "Checkout API configuration must contain a valid API base URL.",
    );
  }
}

/** 글로벌 fetch가 없을 수 있는 테스트·비브라우저 환경을 명확한 오류로 구분합니다. */
function resolveFetchImplementation(fetchImplementation?: typeof fetch): typeof fetch {
  if (fetchImplementation) {
    return fetchImplementation;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch;
  }

  throw new CheckoutClientUnavailableError(
    "A browser fetch implementation is required to start checkout.",
  );
}

/** 토큰 제공자의 구현 예외나 빈 값을 토큰 자체를 노출하지 않는 인증 오류로 바꿉니다. */
async function getAccessToken(
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider,
): Promise<string> {
  try {
    const accessToken = await authorizationTokenProvider.getAccessToken();
    const normalizedAccessToken = accessToken?.trim();

    if (!normalizedAccessToken) {
      throw new CheckoutAuthorizationRequiredError();
    }

    return normalizedAccessToken;
  } catch (error) {
    if (error instanceof CheckoutAuthorizationRequiredError) {
      throw error;
    }

    throw new CheckoutAuthorizationRequiredError();
  }
}

/** 헤더 주입 전에 멱등성 키가 HTTP 헤더에 안전한 형식인지 확인합니다. */
function getValidIdempotencyKey(idempotencyKey: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/.test(idempotencyKey)) {
    throw new CheckoutClientUnavailableError(
      "The checkout idempotency key factory returned an invalid key.",
    );
  }

  return idempotencyKey;
}

/** 응답을 한 번만 파싱하고 JSON이 아닌 오류 페이지가 API 성공처럼 처리되지 않게 합니다. */
async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CheckoutApiResponseError();
  }
}

/** Lambda가 반환한 주문·결제창 준비 정보를 모두 검증합니다. */
function parseCheckoutSession(value: unknown): CheckoutSession {
  if (!isRecord(value)) {
    throw new CheckoutApiResponseError();
  }

  if (
    typeof value.orderId !== "string" ||
    !/^[A-Za-z0-9_-]{6,64}$/.test(value.orderId) ||
    typeof value.orderName !== "string" ||
    !value.orderName.trim() ||
    value.orderName.length > 100 ||
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 1 ||
    value.currency !== "KRW" ||
    typeof value.customerKey !== "string" ||
    value.customerKey.length < 2 ||
    value.customerKey.length > 300 ||
    typeof value.checkoutReturnToken !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.checkoutReturnToken)
  ) {
    throw new CheckoutApiResponseError();
  }

  return {
    orderId: value.orderId,
    orderName: value.orderName,
    amount: value.amount,
    currency: "KRW",
    customerKey: value.customerKey,
    checkoutReturnToken: value.checkoutReturnToken,
  };
}

/** 결제 승인 API가 반환한 주문 상태를 제한된 상태 집합으로 검증합니다. */
function parseConfirmedPayment(value: unknown): ConfirmedPayment {
  if (
    !isRecord(value) ||
    typeof value.orderId !== "string" ||
    !/^[A-Za-z0-9_-]{6,64}$/.test(value.orderId) ||
    (value.status !== "PAID" && value.status !== "PENDING_PAYMENT") ||
    typeof value.paymentStatus !== "string" ||
    !value.paymentStatus.trim()
  ) {
    throw new CheckoutApiResponseError();
  }

  return {
    orderId: value.orderId,
    status: value.status,
    paymentStatus: value.paymentStatus,
  };
}

/** unknown API 응답의 객체 여부만 좁혀 안전한 필드 검증에 사용합니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
