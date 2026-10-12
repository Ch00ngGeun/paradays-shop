/**
 * 역할: 서버에서만 Toss Payments Core API를 호출하고, Secrets Manager 비밀키를 캐시함.
 * 기능: 결제 승인·조회·전체 취소 요청과 응답 검증을 제공하며 비밀값·PG 원문 오류를 외부로 노출하지 않음.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** Toss Payments Core API의 고정 HTTPS origin입니다. */
const TOSS_PAYMENTS_API_ORIGIN = "https://api.tosspayments.com";

/** Secrets Manager JSON에 저장할 최소 Toss Payments server credential입니다. */
export type TossPaymentsCredentials = Readonly<{
  secretKey: string;
}>;

/** Core API가 반환하는 결제 정보 중 주문 상태 검증에 필요한 공개 필드입니다. */
export type TossPayment = Readonly<{
  paymentKey: string;
  orderId: string;
  totalAmount: number;
  status: string;
  approvedAt?: string;
}>;

/** 외부 PG 통신 실패를 Lambda handler가 안전한 502로 바꾸기 위한 오류입니다. */
export class TossPaymentsApiError extends Error {
  constructor(readonly status: number | null = null) {
    super("TOSS_PAYMENTS_API_ERROR");
    this.name = "TossPaymentsApiError";
  }
}

/** Lambda 컨테이너당 한 번만 Secrets Manager를 조회합니다. */
const secretsManagerClient = new SecretsManagerClient({});
const credentialsBySecretArn = new Map<string, Promise<TossPaymentsCredentials>>();

/** Secrets Manager JSON에서 secretKey만 꺼내며, 누락·형식 오류는 provider unavailable로 처리합니다. */
export function getTossPaymentsCredentials(
  secretArn: string,
): Promise<TossPaymentsCredentials> {
  const cachedCredentials = credentialsBySecretArn.get(secretArn);

  if (cachedCredentials) {
    return cachedCredentials;
  }

  const credentials = readTossPaymentsCredentials(secretArn).catch((error: unknown) => {
    credentialsBySecretArn.delete(secretArn);
    throw error;
  });

  credentialsBySecretArn.set(secretArn, credentials);

  return credentials;
}

/** orderId·금액·paymentKey를 Toss 승인 API로 전달하고 응답을 최소 필드로 검증합니다. */
export async function confirmTossPayment({
  credentials,
  paymentKey,
  orderId,
  amount,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
  orderId: string;
  amount: number;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "POST",
    path: "/v1/payments/confirm",
    idempotencyKey: `confirm-${orderId}`,
    body: { paymentKey, orderId, amount },
  });
}

/** 서명 없는 일반 결제 webhook은 paymentKey로 Toss 서버에 재조회해 신뢰합니다. */
export async function getTossPayment({
  credentials,
  paymentKey,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "GET",
    path: `/v1/payments/${encodeURIComponent(paymentKey)}`,
  });
}

/** 관리자 full refund 요청을 PG에 전달합니다. 부분 취소는 정책 확정 후 별도 계약으로 추가합니다. */
export async function cancelTossPayment({
  credentials,
  paymentKey,
  orderId,
  cancelReason,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  paymentKey: string;
  orderId: string;
  cancelReason: string;
}>): Promise<TossPayment> {
  return requestTossPayment({
    credentials,
    method: "POST",
    path: `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
    idempotencyKey: `refund-${orderId}`,
    body: { cancelReason },
  });
}

/** Secrets Manager가 반환한 JSON을 파싱하고 실제 server secret 외의 속성은 무시합니다. */
async function readTossPaymentsCredentials(
  secretArn: string,
): Promise<TossPaymentsCredentials> {
  let response;

  try {
    response = await secretsManagerClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
  } catch {
    throw new TossPaymentsApiError();
  }

  if (!response.SecretString) {
    throw new TossPaymentsApiError();
  }

  try {
    const parsedSecret: unknown = JSON.parse(response.SecretString);

    if (
      !isRecord(parsedSecret) ||
      typeof parsedSecret.secretKey !== "string" ||
      !parsedSecret.secretKey.trim()
    ) {
      throw new Error("secretKey is missing");
    }

    return { secretKey: parsedSecret.secretKey.trim() };
  } catch {
    throw new TossPaymentsApiError();
  }
}

/** Basic 인증의 colon까지 포함해 Toss Payments Core API 요청을 만들고 응답을 검증합니다. */
async function requestTossPayment({
  credentials,
  method,
  path,
  body,
  idempotencyKey,
}: Readonly<{
  credentials: TossPaymentsCredentials;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}>): Promise<TossPayment> {
  let response: Response;

  try {
    response = await fetch(new URL(path, TOSS_PAYMENTS_API_ORIGIN), {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.secretKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new TossPaymentsApiError();
  }

  if (!response.ok) {
    throw new TossPaymentsApiError(response.status);
  }

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    throw new TossPaymentsApiError(response.status);
  }

  if (!isTossPayment(responseBody)) {
    throw new TossPaymentsApiError(response.status);
  }

  return responseBody;
}

/** Toss API의 결제 응답이 서버 비교에 필요한 필드를 갖췄는지 좁힙니다. */
function isTossPayment(value: unknown): value is TossPayment {
  return (
    isRecord(value) &&
    typeof value.paymentKey === "string" &&
    Boolean(value.paymentKey) &&
    typeof value.orderId === "string" &&
    Boolean(value.orderId) &&
    typeof value.totalAmount === "number" &&
    Number.isSafeInteger(value.totalAmount) &&
    typeof value.status === "string" &&
    Boolean(value.status) &&
    (value.approvedAt === undefined || typeof value.approvedAt === "string")
  );
}

/** external API JSON value의 객체 여부만 검증합니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
