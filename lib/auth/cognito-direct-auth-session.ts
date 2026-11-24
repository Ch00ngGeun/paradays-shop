// 역할: 직접 로그인 응답의 access/ID token을 검증해 메모리 세션으로 바꿉니다.
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  CognitoAuthError,
  resolveAccessTokenExpiresAt,
  type AuthenticatedUser,
  type InMemoryAuthSession,
} from "@/lib/auth/cognito-client";

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

export function createSessionFromTokens({
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
