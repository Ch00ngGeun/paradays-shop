// 역할: Hosted UI authorization code를 token으로 교환하고 ID token claim을 검증해 세션을 만듭니다.
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  CognitoAuthError,
  resolveAccessTokenExpiresAt,
  type AuthenticatedUser,
  type InMemoryAuthSession,
  type TokenFetcher,
} from "@/lib/auth/cognito-client";
import type { PkceTransaction } from "@/lib/auth/cognito-client-pkce";

/** JWT claim JSON을 안전하게 다루기 위한 최소 타입. */
type JwtClaims = Record<string, unknown>;

/** Token endpoint의 성공 응답에서 필요한 공개 필드만 읽는 타입. */
type TokenResponse = Readonly<{
  access_token: string;
  id_token: string;
  expires_in: number;
}>;

/** Token endpoint 반환값이 access/id token과 만료 시간을 갖는지 확인합니다. */
function isTokenResponse(value: unknown): value is TokenResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const tokenResponse = value as Record<string, unknown>;

  return (
    typeof tokenResponse.access_token === "string" &&
    typeof tokenResponse.id_token === "string" &&
    typeof tokenResponse.expires_in === "number" &&
    Number.isFinite(tokenResponse.expires_in) &&
    tokenResponse.expires_in > 0
  );
}

/** base64url JWT payload를 UTF-8 JSON 문자열로 디코드합니다. 서명 검증은 API에서 수행해야 합니다. */
export function decodeJwtPayload(token: string): JwtClaims {
  const [, payload] = token.split(".");

  if (!payload) {
    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token 형식이 올바르지 않습니다.",
    );
  }

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedBase64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(paddedBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsedClaims: unknown = JSON.parse(new TextDecoder().decode(bytes));

    if (typeof parsedClaims !== "object" || parsedClaims === null) {
      throw new Error("JWT payload must be an object");
    }

    return parsedClaims as JwtClaims;
  } catch (error) {
    if (error instanceof CognitoAuthError) {
      throw error;
    }

    throw new CognitoAuthError(
      "AUTH_ID_TOKEN_INVALID",
      "ID token 내용을 읽을 수 없습니다.",
    );
  }
}

/** string claim만 안전하게 읽습니다. */
function readStringClaim(claims: JwtClaims, name: string) {
  const value = claims[name];

  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Cognito group claim을 문자열 목록으로 정규화합니다. */
function readGroupsClaim(claims: JwtClaims) {
  const groups = claims["cognito:groups"];

  return Array.isArray(groups)
    ? groups.filter((group): group is string => typeof group === "string")
    : [];
}

/** ID token의 표준 claims와 nonce/audience/issuer를 최소한 검증해 UI 사용자 정보를 만듭니다. */
function createUserFromIdToken({
  idToken,
  config,
  expectedNonce,
  now,
}: Readonly<{
  idToken: string;
  config: CognitoAuthConfig;
  expectedNonce: string;
  now: number;
}>) {
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
    claims.nonce !== expectedNonce ||
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

  const username =
    readStringClaim(claims, "cognito:username") ??
    readStringClaim(claims, "username") ??
    sub;

  return {
    user: {
      sub,
      username,
      ...(readStringClaim(claims, "email")
        ? { email: readStringClaim(claims, "email") }
        : {}),
      ...(readStringClaim(claims, "name")
        ? { displayName: readStringClaim(claims, "name") }
        : {}),
      groups: readGroupsClaim(claims),
    },
    expiration,
  } satisfies Readonly<{ user: AuthenticatedUser; expiration: number }>;
}

/** authorization code를 Cognito token endpoint에서 메모리 세션으로 교환합니다. */
export async function exchangeAuthorizationCode({
  code,
  transaction,
  config,
  fetcher,
  now,
}: Readonly<{
  code: string;
  transaction: PkceTransaction;
  config: CognitoAuthConfig;
  fetcher: TokenFetcher;
  now: number;
}>) {
  let response: Response;

  try {
    response = await fetcher(`${config.domain}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: transaction.verifier,
      }).toString(),
    });
  } catch {
    throw new CognitoAuthError(
      "AUTH_TOKEN_EXCHANGE_FAILED",
      "Cognito와 로그인 정보를 교환하지 못했습니다.",
    );
  }

  if (!response.ok) {
    throw new CognitoAuthError(
      "AUTH_TOKEN_EXCHANGE_FAILED",
      "Cognito가 로그인 정보를 승인하지 않았습니다.",
    );
  }

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    throw new CognitoAuthError(
      "AUTH_TOKEN_RESPONSE_INVALID",
      "Cognito token 응답을 읽을 수 없습니다.",
    );
  }

  if (!isTokenResponse(responseBody)) {
    throw new CognitoAuthError(
      "AUTH_TOKEN_RESPONSE_INVALID",
      "Cognito token 응답 형식이 올바르지 않습니다.",
    );
  }

  const { user, expiration } = createUserFromIdToken({
    idToken: responseBody.id_token,
    config,
    expectedNonce: transaction.nonce,
    now,
  });

  const accessFallback = now + responseBody.expires_in * 1000;
  const accessExpiresAt = resolveAccessTokenExpiresAt(
    responseBody.access_token,
    accessFallback,
  );

  return {
    accessToken: responseBody.access_token,
    // access token 응답 만료·JWT exp·ID token exp 중 더 이른 시점을 사용합니다.
    expiresAt: Math.max(
      now + 60_000,
      Math.min(accessFallback, accessExpiresAt, expiration * 1000),
    ),
    user,
  } satisfies InMemoryAuthSession;
}
