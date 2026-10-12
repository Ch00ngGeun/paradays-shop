// 역할: Cognito access token으로 회원 프로필과 본인 주문 내역을 AWS Commerce API에서 읽고 수정하는 클라이언트를 제공합니다.
import {
  CheckoutAuthorizationRequiredError,
  CheckoutClientUnavailableError,
  getCheckoutApiConfig,
  readCheckoutPublicEnvironment,
  type CheckoutApiConfig,
  type CheckoutAuthorizationTokenProvider,
  type CheckoutPublicEnvironment,
} from "@/lib/commerce/checkout-api-client";

/** 회원 계정 화면에 필요한 최소 프로필입니다. 비밀번호·토큰은 포함하지 않습니다. */
export type MemberProfile = Readonly<{
  userSub: string;
  email?: string;
  displayName?: string;
  phoneNumber?: string;
  marketingConsent: boolean;
  createdAt?: string;
  updatedAt?: string;
}>;

/** 회원이 볼 수 있는 주문 목록 한 줄입니다. */
export type MemberOrderSummary = Readonly<{
  orderId: string;
  orderName: string;
  status: "PENDING_PAYMENT" | "PAID" | "FAILED" | "CANCELED" | "REFUNDED";
  paymentStatus: string;
  total: number;
  currency: "KRW";
  createdAt: string;
}>;

/** 계정에서 수정 가능한 도메인 필드만 전송합니다. */
export type UpdateMemberProfileInput = Readonly<{
  displayName?: string;
  phoneNumber?: string;
  marketingConsent?: boolean;
}>;

/** API 호출 의존성을 명시적으로 주입해 UI와 테스트가 같은 계약을 사용하게 합니다. */
export type MemberApiClientDependencies = Readonly<{
  config: CheckoutApiConfig;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  fetchImplementation?: typeof fetch;
}>;

/** 계정 UI가 사용하는 profile·order API 인터페이스입니다. */
export type MemberApiClient = Readonly<{
  getProfile: () => Promise<MemberProfile>;
  updateProfile: (input: UpdateMemberProfileInput) => Promise<MemberProfile>;
  listOrders: () => Promise<MemberOrderSummary[]>;
}>;

/** API가 거절한 회원 요청을 HTTP status만 보존해 UI가 민감한 본문을 표시하지 않게 합니다. */
export class MemberApiRequestError extends Error {
  readonly code = "MEMBER_API_REQUEST_FAILED";

  constructor(readonly status: number) {
    super(`MEMBER_API_REQUEST_FAILED: ${status}`);
    this.name = "MemberApiRequestError";
  }
}

/** 회원 API의 응답 형식이 예상과 다르면 안전하게 중단합니다. */
export class MemberApiResponseError extends Error {
  readonly code = "MEMBER_API_RESPONSE_INVALID";

  constructor() {
    super("MEMBER_API_RESPONSE_INVALID: Member API response is invalid.");
    this.name = "MemberApiResponseError";
  }
}

/** 공개 API URL과 Cognito 토큰 제공자를 연결한 회원 API 클라이언트를 만듭니다. */
export function createMemberApiClient(
  dependencies: MemberApiClientDependencies,
): MemberApiClient {
  const fetchImplementation = resolveFetchImplementation(
    dependencies.fetchImplementation,
  );
  const profileUrl = buildApiUrl(dependencies.config.apiBaseUrl, "me");
  const ordersUrl = buildApiUrl(dependencies.config.apiBaseUrl, "orders");

  return {
    async getProfile() {
      const response = await fetchWithAuthorization({
        fetchImplementation,
        url: profileUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        method: "GET",
      });

      if (!response.ok) {
        throw new MemberApiRequestError(response.status);
      }

      return parseMemberProfile(await readJsonResponse(response));
    },
    async updateProfile(input) {
      const response = await fetchWithAuthorization({
        fetchImplementation,
        url: profileUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        method: "PATCH",
        body: JSON.stringify(removeUndefinedFields(input)),
      });

      if (!response.ok) {
        throw new MemberApiRequestError(response.status);
      }

      return parseMemberProfile(await readJsonResponse(response));
    },
    async listOrders() {
      const response = await fetchWithAuthorization({
        fetchImplementation,
        url: ordersUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        method: "GET",
      });

      if (!response.ok) {
        throw new MemberApiRequestError(response.status);
      }

      return parseOrderList(await readJsonResponse(response));
    },
  };
}

/** 실제 브라우저에서는 공개 환경변수만 읽고, 테스트에서는 환경 객체를 주입할 수 있게 합니다. */
export function createMemberApiClientFromEnvironment(
  dependencies: Omit<MemberApiClientDependencies, "config">,
  environment: CheckoutPublicEnvironment = readCheckoutPublicEnvironment(),
) {
  return createMemberApiClient({
    ...dependencies,
    config: getCheckoutApiConfig(environment),
  });
}

/** 인증된 API 호출에만 bearer token을 넣고, 빈 token은 로그아웃 상태로 명확히 처리합니다. */
async function fetchWithAuthorization({
  fetchImplementation,
  url,
  authorizationTokenProvider,
  method,
  body,
}: Readonly<{
  fetchImplementation: typeof fetch;
  url: string;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  method: "GET" | "PATCH";
  body?: string;
}>) {
  const accessToken = await getAccessToken(authorizationTokenProvider);

  return fetchImplementation(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

/** 토큰 제공자의 예외와 빈 값을 checkout과 동일한 인증 오류로 정규화합니다. */
async function getAccessToken(
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider,
): Promise<string> {
  try {
    const accessToken = await authorizationTokenProvider.getAccessToken();
    const normalizedToken = accessToken?.trim();

    if (!normalizedToken) {
      throw new CheckoutAuthorizationRequiredError();
    }

    return normalizedToken;
  } catch (error) {
    if (error instanceof CheckoutAuthorizationRequiredError) {
      throw error;
    }

    throw new CheckoutAuthorizationRequiredError();
  }
}

/** global fetch가 없는 비브라우저·테스트 환경을 명확한 구성 오류로 처리합니다. */
function resolveFetchImplementation(fetchImplementation?: typeof fetch): typeof fetch {
  if (fetchImplementation) {
    return fetchImplementation;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch;
  }

  throw new CheckoutClientUnavailableError(
    "A browser fetch implementation is required.",
  );
}

/** API Gateway stage path를 보존하며 상대 commerce API 경로를 조합합니다. */
function buildApiUrl(apiBaseUrl: string, path: string) {
  try {
    return new URL(path, `${apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    throw new CheckoutClientUnavailableError(
      "Commerce API configuration must contain a valid URL.",
    );
  }
}

/** undefined를 제거해 PATCH body에 의도하지 않은 null 비슷한 값이 실리지 않게 합니다. */
function removeUndefinedFields(input: UpdateMemberProfileInput) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

/** JSON 응답을 한 번만 읽고 HTML 오류 페이지를 정상 데이터로 오인하지 않습니다. */
async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new MemberApiResponseError();
  }
}

/** profile API의 노출 가능한 필드만 엄격히 검증합니다. */
function parseMemberProfile(value: unknown): MemberProfile {
  if (
    !isRecord(value) ||
    typeof value.userSub !== "string" ||
    !value.userSub.trim() ||
    typeof value.marketingConsent !== "boolean" ||
    !isOptionalString(value.email) ||
    !isOptionalString(value.displayName) ||
    !isOptionalString(value.phoneNumber) ||
    !isOptionalString(value.createdAt) ||
    !isOptionalString(value.updatedAt)
  ) {
    throw new MemberApiResponseError();
  }

  return {
    userSub: value.userSub,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
    ...(typeof value.phoneNumber === "string"
      ? { phoneNumber: value.phoneNumber }
      : {}),
    marketingConsent: value.marketingConsent,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

/** orders 목록이 배열 형태인지 확인하고 각 행도 공개 summary 형식으로 검증합니다. */
function parseOrderList(value: unknown): MemberOrderSummary[] {
  if (!isRecord(value) || !Array.isArray(value.orders)) {
    throw new MemberApiResponseError();
  }

  return value.orders.map(parseOrderSummary);
}

/** 주문 상태·금액·날짜의 기본 계약을 검증해 잘못된 backend 응답을 UI에 렌더링하지 않습니다. */
function parseOrderSummary(value: unknown): MemberOrderSummary {
  if (
    !isRecord(value) ||
    typeof value.orderId !== "string" ||
    typeof value.orderName !== "string" ||
    !isOrderStatus(value.status) ||
    typeof value.paymentStatus !== "string" ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    value.currency !== "KRW" ||
    typeof value.createdAt !== "string"
  ) {
    throw new MemberApiResponseError();
  }

  return {
    orderId: value.orderId,
    orderName: value.orderName,
    status: value.status,
    paymentStatus: value.paymentStatus,
    total: value.total,
    currency: "KRW",
    createdAt: value.createdAt,
  };
}

/** nullable 아닌 optional string 응답 필드만 허용합니다. */
function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

/** backend의 내부 주문 상태가 공개 계약의 상태 집합 안에 있는지 확인합니다. */
function isOrderStatus(value: unknown): value is MemberOrderSummary["status"] {
  return (
    value === "PENDING_PAYMENT" ||
    value === "PAID" ||
    value === "FAILED" ||
    value === "CANCELED" ||
    value === "REFUNDED"
  );
}

/** unknown JSON 응답의 객체 여부를 좁힙니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
