// 역할: Hosted UI 없이 Cognito SignUp / ConfirmSignUp / USER_PASSWORD_AUTH 로그인.

import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  CognitoAuthError,
  resolveAccessTokenExpiresAt,
  type AuthenticatedUser,
  type InMemoryAuthSession,
} from "@/lib/auth/cognito-client";

export type IdentityVerificationMethod = "email" | "sms";

export type CodeDeliveryDetails = Readonly<{
  destination?: string;
  deliveryMedium?: string;
  attributeName?: string;
}>;

export type SignUpDirectResult = Readonly<{
  userConfirmed: boolean;
  userSub?: string;
  codeDelivery?: CodeDeliveryDetails;
}>;

type CognitoIdpErrorBody = Readonly<{
  __type?: string;
  message?: string;
  Message?: string;
}>;

type CognitoIdpFetcher = (input: string, init: RequestInit) => Promise<Response>;

function getRegionFromIssuer(issuer: string | undefined) {
  if (!issuer) {
    return null;
  }

  try {
    const { hostname } = new URL(issuer);
    const match = /^cognito-idp\.([a-z0-9-]+)\.amazonaws\.com$/i.exec(hostname);

    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function getIdpEndpoint(config: CognitoAuthConfig) {
  const region = getRegionFromIssuer(config.issuer);

  if (!region) {
    throw new CognitoAuthError(
      "AUTH_DIRECT_CONFIG_INVALID",
      "Cognito issuer에서 리전을 확인할 수 없습니다.",
    );
  }

  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function callCognitoIdp<T>({
  config,
  target,
  body,
  fetcher,
}: Readonly<{
  config: CognitoAuthConfig;
  target: string;
  body: Record<string, unknown>;
  fetcher: CognitoIdpFetcher;
}>): Promise<T> {
  let response: Response;

  try {
    response = await fetcher(getIdpEndpoint(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CognitoAuthError("AUTH_DIRECT_NETWORK", "Cognito에 연결하지 못했습니다.");
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new CognitoAuthError(
      "AUTH_DIRECT_RESPONSE_INVALID",
      "Cognito 응답을 읽을 수 없습니다.",
    );
  }

  if (!response.ok) {
    const errorBody = payload as CognitoIdpErrorBody;
    const type = errorBody.__type?.split("#").pop() ?? "UnknownError";
    const message =
      errorBody.message ?? errorBody.Message ?? "Cognito 요청이 거절되었습니다.";

    throw mapCognitoIdpError(type, message);
  }

  return payload as T;
}

function mapCognitoIdpError(type: string, message: string) {
  switch (type) {
    case "UsernameExistsException":
      return new CognitoAuthError(
        "AUTH_DIRECT_USERNAME_EXISTS",
        "이미 가입된 이메일입니다.",
      );
    case "InvalidPasswordException":
      return new CognitoAuthError(
        "AUTH_DIRECT_INVALID_PASSWORD",
        "비밀번호 조건을 충족하지 않습니다.",
      );
    case "InvalidParameterException":
      return new CognitoAuthError("AUTH_DIRECT_INVALID_PARAMETER", message);
    case "CodeMismatchException":
      return new CognitoAuthError(
        "AUTH_DIRECT_CODE_MISMATCH",
        "인증 코드가 올바르지 않습니다.",
      );
    case "ExpiredCodeException":
      return new CognitoAuthError(
        "AUTH_DIRECT_CODE_EXPIRED",
        "인증 코드가 만료되었습니다. 다시 요청하세요.",
      );
    case "UserNotFoundException":
    case "NotAuthorizedException":
      return new CognitoAuthError(
        "AUTH_DIRECT_NOT_AUTHORIZED",
        "아이디 또는 비밀번호가 올바르지 않습니다.",
      );
    case "UserNotConfirmedException":
      return new CognitoAuthError(
        "AUTH_DIRECT_NOT_CONFIRMED",
        "이메일 인증이 아직 완료되지 않았습니다.",
      );
    case "LimitExceededException":
    case "TooManyRequestsException":
      return new CognitoAuthError(
        "AUTH_DIRECT_RATE_LIMITED",
        "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
      );
    default:
      return new CognitoAuthError("AUTH_DIRECT_FAILED", message);
  }
}

function readCodeDelivery(value: unknown): CodeDeliveryDetails | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const details = value as Record<string, unknown>;

  return {
    ...(typeof details.Destination === "string"
      ? { destination: details.Destination }
      : {}),
    ...(typeof details.DeliveryMedium === "string"
      ? { deliveryMedium: details.DeliveryMedium }
      : {}),
    ...(typeof details.AttributeName === "string"
      ? { attributeName: details.AttributeName }
      : {}),
  };
}

/** 한국 휴대폰 번호를 Cognito E.164(+82…)로 정규화함. */
export function normalizeKoreanPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("82") && digits.length >= 11) {
    return `+${digits}`;
  }

  if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 11) {
    return `+82${digits.slice(1)}`;
  }

  return null;
}

export function isValidKoreanPhoneNumber(value: string) {
  return normalizeKoreanPhoneNumber(value) !== null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");

  if (!payload) {
    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token 형식이 올바르지 않습니다.",
    );
  }

  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

  if (typeof parsed !== "object" || parsed === null) {
    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token 내용을 읽을 수 없습니다.",
    );
  }

  return parsed as Record<string, unknown>;
}

function readStringClaim(claims: Record<string, unknown>, name: string) {
  const value = claims[name];

  return typeof value === "string" && value.trim() ? value : undefined;
}

function createUserFromIdToken(
  idToken: string,
  config: CognitoAuthConfig,
  now: number,
): AuthenticatedUser {
  const claims = decodeJwtPayload(idToken);
  const sub = readStringClaim(claims, "sub");
  const audience = claims.aud;
  const audienceMatches =
    audience === config.clientId ||
    (Array.isArray(audience) && audience.some((value) => value === config.clientId));
  const expiration = claims.exp;

  if (
    !sub ||
    !audienceMatches ||
    claims.token_use !== "id" ||
    typeof expiration !== "number" ||
    expiration * 1000 <= now
  ) {
    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token 검증에 실패했습니다.",
    );
  }

  if (config.issuer && claims.iss !== config.issuer) {
    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token issuer가 일치하지 않습니다.",
    );
  }

  const groups = claims["cognito:groups"];

  return {
    sub,
    username:
      readStringClaim(claims, "cognito:username") ??
      readStringClaim(claims, "username") ??
      sub,
    ...(readStringClaim(claims, "email")
      ? { email: readStringClaim(claims, "email") }
      : {}),
    ...(readStringClaim(claims, "name")
      ? { displayName: readStringClaim(claims, "name") }
      : {}),
    groups: Array.isArray(groups)
      ? groups.filter((group): group is string => typeof group === "string")
      : [],
  };
}

function createSessionFromTokens({
  accessToken,
  idToken,
  expiresIn,
  config,
  now,
}: Readonly<{
  accessToken: string;
  idToken: string;
  expiresIn: number;
  config: CognitoAuthConfig;
  now: number;
}>): InMemoryAuthSession {
  const user = createUserFromIdToken(idToken, config, now);
  const claims = decodeJwtPayload(idToken);
  const idExp =
    typeof claims.exp === "number" ? claims.exp * 1000 : now + expiresIn * 1000;
  const accessFallback = now + expiresIn * 1000;
  const accessExpiresAt = resolveAccessTokenExpiresAt(accessToken, accessFallback);
  // 시계 오차로 로그인 직후 만료 판정나지 않도록 최소 60초는 유지합니다.
  const expiresAt = Math.max(
    now + 60_000,
    Math.min(accessFallback, accessExpiresAt, idExp),
  );

  return {
    accessToken,
    expiresAt,
    user,
  };
}

/** 이메일·비밀번호로 Cognito 가입. 확인 코드는 email로 발송됨. SMS 본인인증 시 firebaseIdToken으로 PreSignUp 자동확인. */
export async function signUpWithPassword({
  config,
  email,
  password,
  phoneNumber,
  firebaseIdToken,
  fetcher = (input, init) => fetch(input, init),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  password: string;
  phoneNumber?: string;
  firebaseIdToken?: string;
  fetcher?: CognitoIdpFetcher;
}>): Promise<SignUpDirectResult> {
  const userAttributes: Array<{ Name: string; Value: string }> = [
    { Name: "email", Value: email },
  ];

  if (phoneNumber) {
    const normalizedPhone = normalizeKoreanPhoneNumber(phoneNumber);

    if (!normalizedPhone) {
      throw new CognitoAuthError(
        "AUTH_DIRECT_INVALID_PARAMETER",
        "휴대폰 번호 형식이 올바르지 않습니다.",
      );
    }

    userAttributes.push({ Name: "phone_number", Value: normalizedPhone });
  }

  const response = await callCognitoIdp<{
    UserConfirmed?: boolean;
    UserSub?: string;
    CodeDeliveryDetails?: unknown;
  }>({
    config,
    target: "SignUp",
    body: {
      ClientId: config.clientId,
      Username: email,
      Password: password,
      UserAttributes: userAttributes,
      ...(firebaseIdToken ? { ClientMetadata: { firebaseIdToken } } : {}),
    },
    fetcher,
  });

  return {
    userConfirmed: Boolean(response.UserConfirmed),
    ...(typeof response.UserSub === "string" ? { userSub: response.UserSub } : {}),
    ...(readCodeDelivery(response.CodeDeliveryDetails)
      ? { codeDelivery: readCodeDelivery(response.CodeDeliveryDetails) }
      : {}),
  };
}

/** 가입 확인 코드 검증. */
export async function confirmSignUpWithCode({
  config,
  email,
  code,
  fetcher = (input, init) => fetch(input, init),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  code: string;
  fetcher?: CognitoIdpFetcher;
}>) {
  await callCognitoIdp({
    config,
    target: "ConfirmSignUp",
    body: {
      ClientId: config.clientId,
      Username: email,
      ConfirmationCode: code.trim(),
    },
    fetcher,
  });
}

/** 확인 코드 재발송. */
export async function resendSignUpConfirmationCode({
  config,
  email,
  fetcher = (input, init) => fetch(input, init),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  fetcher?: CognitoIdpFetcher;
}>): Promise<CodeDeliveryDetails | undefined> {
  const response = await callCognitoIdp<{ CodeDeliveryDetails?: unknown }>({
    config,
    target: "ResendConfirmationCode",
    body: {
      ClientId: config.clientId,
      Username: email,
    },
    fetcher,
  });

  return readCodeDelivery(response.CodeDeliveryDetails);
}

/** USER_PASSWORD_AUTH로 바로 로그인해 메모리 세션을 만듦. */
export async function signInWithPassword({
  config,
  email,
  password,
  fetcher = (input, init) => fetch(input, init),
  now = Date.now(),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  password: string;
  fetcher?: CognitoIdpFetcher;
  now?: number;
}>): Promise<InMemoryAuthSession> {
  const response = await callCognitoIdp<{
    AuthenticationResult?: {
      AccessToken?: string;
      IdToken?: string;
      ExpiresIn?: number;
    };
    ChallengeName?: string;
  }>({
    config,
    target: "InitiateAuth",
    body: {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    },
    fetcher,
  });

  const result = response.AuthenticationResult;

  if (!result?.AccessToken || !result.IdToken || typeof result.ExpiresIn !== "number") {
    throw new CognitoAuthError(
      "AUTH_DIRECT_CHALLENGE",
      response.ChallengeName
        ? `추가 인증이 필요합니다 (${response.ChallengeName}).`
        : "로그인 토큰을 받지 못했습니다.",
    );
  }

  return createSessionFromTokens({
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    expiresIn: result.ExpiresIn,
    config,
    now,
  });
}

/** 비밀번호 재설정 코드 발송 (이메일을 Cognito username으로 사용). */
export async function forgotPassword({
  config,
  email,
  fetcher = (input, init) => fetch(input, init),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  fetcher?: CognitoIdpFetcher;
}>): Promise<CodeDeliveryDetails | undefined> {
  const response = await callCognitoIdp<{ CodeDeliveryDetails?: unknown }>({
    config,
    target: "ForgotPassword",
    body: {
      ClientId: config.clientId,
      Username: email,
    },
    fetcher,
  });

  return readCodeDelivery(response.CodeDeliveryDetails);
}

/** 비밀번호 재설정 코드 확인 + 새 비밀번호 설정. */
export async function confirmForgotPassword({
  config,
  email,
  code,
  newPassword,
  fetcher = (input, init) => fetch(input, init),
}: Readonly<{
  config: CognitoAuthConfig;
  email: string;
  code: string;
  newPassword: string;
  fetcher?: CognitoIdpFetcher;
}>) {
  await callCognitoIdp({
    config,
    target: "ConfirmForgotPassword",
    body: {
      ClientId: config.clientId,
      Username: email,
      ConfirmationCode: code.trim(),
      Password: newPassword,
    },
    fetcher,
  });
}
