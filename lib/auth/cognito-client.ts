// 역할: Cognito Hosted UI Authorization Code + PKCE 요청, callback 교환, 메모리 세션 변환을 제공합니다.

import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  createCodeChallenge,
  createCodeVerifier,
  createRandomValue,
} from "@/lib/auth/pkce";

/** PKCE verifier와 CSRF/OIDC 검증값만 잠시 보관하는 sessionStorage 키. */
export const PKCE_TRANSACTION_STORAGE_KEY = "paradays.auth.pkce";

/**
 * 동일 탭의 정적 페이지 이동·새로고침에서도 로그인을 유지하기 위한 세션 키.
 * sessionStorage를 우선하고, 같은 origin 하드 네비게이션 보조로 localStorage에도 복제합니다.
 */
export const AUTH_SESSION_STORAGE_KEY = "paradays.auth.session";

/** 로그인 창을 오래 열어둔 뒤 재사용되는 verifier를 막기 위한 만료 시간. */
const PKCE_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

/** Hosted UI에서 가입 화면을 바로 열지, 기본 로그인 흐름을 열지 선택합니다. */
export type HostedUiFlow = "signIn" | "signUp";

/** 브라우저 sessionStorage에서 실제로 쓰는 최소 메서드. */
export type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

/** OIDC callback 전에만 sessionStorage에 남는 짧은 수명 값. */
type PkceTransaction = Readonly<{
  verifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}>;

/** UI와 API 호출에 필요한, 새로고침 전까지만 유지되는 인증 사용자 정보. */
export type AuthenticatedUser = Readonly<{
  sub: string;
  username: string;
  email?: string;
  displayName?: string;
  groups: readonly string[];
}>;

/** access token을 메모리 안에만 두는 세션. Context는 token 자체를 렌더링하지 않습니다. */
export type InMemoryAuthSession = Readonly<{
  accessToken: string;
  expiresAt: number;
  user: AuthenticatedUser;
}>;

/**
 * 동일 JS 런타임(클라이언트 라우팅·Provider 리마운트)에서 sessionStorage보다 먼저 쓰는 탭 메모리.
 * 하드 새로고침 시에는 비고 sessionStorage에서 복원합니다.
 */
let tabAuthSessionMemory: InMemoryAuthSession | null = null;

/** 로그인·복원 직후 탭 메모리를 맞춰 Provider 리마운트에도 세션이 끊기지 않게 합니다. */
export function rememberTabAuthSession(session: InMemoryAuthSession | null) {
  tabAuthSessionMemory = session;
}

/** 만료되지 않은 탭 메모리 세션만 반환합니다. */
export function readTabAuthSession(now = Date.now()): InMemoryAuthSession | null {
  if (!tabAuthSessionMemory) {
    return null;
  }

  if (tabAuthSessionMemory.expiresAt <= now) {
    tabAuthSessionMemory = null;
    return null;
  }

  return tabAuthSessionMemory;
}

/** 인증 실패를 UI·로그에 안전하게 구분하기 위한 제한된 오류 코드. */
export type CognitoAuthErrorCode =
  | "AUTH_CALLBACK_ERROR"
  | "AUTH_CALLBACK_STATE_INVALID"
  | "AUTH_CALLBACK_TRANSACTION_MISSING"
  | "AUTH_CALLBACK_TRANSACTION_EXPIRED"
  | "AUTH_ID_TOKEN_INVALID"
  | "AUTH_PKCE_STORAGE_UNAVAILABLE"
  | "AUTH_TOKEN_EXCHANGE_FAILED"
  | "AUTH_TOKEN_RESPONSE_INVALID"
  | "AUTH_WEB_CRYPTO_UNAVAILABLE"
  | "AUTH_DIRECT_CONFIG_INVALID"
  | "AUTH_DIRECT_NETWORK"
  | "AUTH_DIRECT_RESPONSE_INVALID"
  | "AUTH_DIRECT_USERNAME_EXISTS"
  | "AUTH_DIRECT_INVALID_PASSWORD"
  | "AUTH_DIRECT_INVALID_PARAMETER"
  | "AUTH_DIRECT_CODE_MISMATCH"
  | "AUTH_DIRECT_CODE_EXPIRED"
  | "AUTH_DIRECT_NOT_AUTHORIZED"
  | "AUTH_DIRECT_NOT_CONFIRMED"
  | "AUTH_DIRECT_RATE_LIMITED"
  | "AUTH_DIRECT_FAILED"
  | "AUTH_DIRECT_CHALLENGE"
  | "AUTH_IDENTITY_UNAVAILABLE"
  | "AUTH_IDENTITY_CANCELLED"
  | "AUTH_IDENTITY_FAILED";

/** 토큰·코드·사용자 입력을 담지 않는 인증 오류 객체. */
export class CognitoAuthError extends Error {
  readonly code: CognitoAuthErrorCode;

  constructor(code: CognitoAuthErrorCode, message: string) {
    super(message);
    this.name = "CognitoAuthError";
    this.code = code;
  }
}

/** Hosted UI callback 처리 결과. */
export type HostedUiCallbackResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "authenticated"; session: InMemoryAuthSession }>
  | Readonly<{ kind: "error"; error: CognitoAuthError }>;

/** fetch를 테스트에서 교체할 수 있도록 좁힌 token endpoint 호출 타입. */
export type TokenFetcher = (input: string, init: RequestInit) => Promise<Response>;

/** JWT claim JSON을 안전하게 다루기 위한 최소 타입. */
type JwtClaims = Record<string, unknown>;

/** Token endpoint의 성공 응답에서 필요한 공개 필드만 읽는 타입. */
type TokenResponse = Readonly<{
  access_token: string;
  id_token: string;
  expires_in: number;
}>;

/** callback URL의 code/state/error 파라미터만 제거해 주소창 재사용을 막습니다. */
export function removeHostedUiCallbackParameters(href: string) {
  const url = new URL(href);

  for (const parameter of [
    "code",
    "state",
    "error",
    "error_description",
    "error_uri",
  ]) {
    url.searchParams.delete(parameter);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

/** 앱의 등록 callback URL과 현재 URL의 origin·path가 같은지 확인합니다. */
function isCallbackUrl(href: string, config: CognitoAuthConfig) {
  const currentUrl = new URL(href);
  const callbackUrl = new URL(config.redirectUri);

  return (
    currentUrl.origin === callbackUrl.origin &&
    currentUrl.pathname === callbackUrl.pathname
  );
}

/** 인증 URL 생성에 필요한 transaction을 sessionStorage에 안전하게 저장합니다. */
function savePkceTransaction(
  storage: SessionStorageLike,
  transaction: PkceTransaction,
) {
  try {
    storage.setItem(PKCE_TRANSACTION_STORAGE_KEY, JSON.stringify(transaction));
  } catch {
    throw new CognitoAuthError(
      "AUTH_PKCE_STORAGE_UNAVAILABLE",
      "로그인 보안 확인값을 현재 탭에 저장할 수 없습니다.",
    );
  }
}

/** callback 직후 일회성 transaction을 꺼냅니다. 잘못된 데이터는 즉시 제거합니다. */
function takePkceTransaction(storage: SessionStorageLike) {
  try {
    const rawTransaction = storage.getItem(PKCE_TRANSACTION_STORAGE_KEY);
    storage.removeItem(PKCE_TRANSACTION_STORAGE_KEY);

    if (!rawTransaction) {
      return null;
    }

    const parsedTransaction: unknown = JSON.parse(rawTransaction);

    if (!isPkceTransaction(parsedTransaction)) {
      return null;
    }

    return parsedTransaction;
  } catch {
    return null;
  }
}

/** 명시적 로그아웃이나 오류 처리에서 남은 verifier/state/nonce를 제거합니다. */
export function clearPkceTransaction(storage: SessionStorageLike) {
  try {
    storage.removeItem(PKCE_TRANSACTION_STORAGE_KEY);
  } catch {
    // 브라우저 저장소가 막혀도 현재 메모리 세션을 비우는 동작은 계속합니다.
  }
}

/** JSON 값이 우리가 만든 PKCE transaction 형태인지 검사합니다. */
function isPkceTransaction(value: unknown): value is PkceTransaction {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const transaction = value as Record<string, unknown>;

  return (
    typeof transaction.verifier === "string" &&
    typeof transaction.state === "string" &&
    typeof transaction.nonce === "string" &&
    typeof transaction.createdAt === "number"
  );
}

/** Hosted UI 로그인·가입 URL을 만든 뒤 브라우저가 이동할 문자열만 반환합니다. */
function buildAuthorizationUrl(
  config: CognitoAuthConfig,
  transaction: PkceTransaction,
  codeChallenge: string,
  flow: HostedUiFlow,
) {
  const url = new URL(
    flow === "signUp" ? "/signup" : "/oauth2/authorize",
    config.domain,
  );

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("nonce", transaction.nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

/** 로그인 또는 가입 직전에 PKCE transaction을 만들고 Cognito redirect URL을 반환합니다. */
export async function createHostedUiAuthorizationUrl({
  config,
  storage,
  flow = "signIn",
  now = Date.now,
}: Readonly<{
  config: CognitoAuthConfig;
  storage: SessionStorageLike;
  flow?: HostedUiFlow;
  now?: () => number;
}>) {
  try {
    const verifier = createCodeVerifier();
    const transaction: PkceTransaction = {
      verifier,
      state: createRandomValue(),
      nonce: createRandomValue(),
      createdAt: now(),
    };
    const codeChallenge = await createCodeChallenge(verifier);

    savePkceTransaction(storage, transaction);

    return buildAuthorizationUrl(config, transaction, codeChallenge, flow);
  } catch (error) {
    if (error instanceof CognitoAuthError) {
      throw error;
    }

    throw new CognitoAuthError(
      "AUTH_WEB_CRYPTO_UNAVAILABLE",
      "현재 브라우저에서 안전한 로그인 보안값을 생성할 수 없습니다.",
    );
  }
}

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
function decodeJwtPayload(token: string): JwtClaims {
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
async function exchangeAuthorizationCode({
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

/** callback query를 검증·교환합니다. API 권한 검증은 항상 서버의 JWT authorizer가 수행해야 합니다. */
export async function completeHostedUiCallback({
  href,
  config,
  storage,
  fetcher = (input, init) => fetch(input, init),
  now = Date.now,
}: Readonly<{
  href: string;
  config: CognitoAuthConfig;
  storage: SessionStorageLike;
  fetcher?: TokenFetcher;
  now?: () => number;
}>): Promise<HostedUiCallbackResult> {
  if (!isCallbackUrl(href, config)) {
    return { kind: "none" };
  }

  const url = new URL(href);
  const code = url.searchParams.get("code");
  const authorizationError = url.searchParams.get("error");

  if (!code && !authorizationError) {
    return { kind: "none" };
  }

  const transaction = takePkceTransaction(storage);

  if (!transaction) {
    return {
      kind: "error",
      error: new CognitoAuthError(
        "AUTH_CALLBACK_TRANSACTION_MISSING",
        "로그인 요청을 확인할 수 없습니다. 다시 로그인해 주세요.",
      ),
    };
  }

  const currentTime = now();

  if (transaction.createdAt + PKCE_TRANSACTION_MAX_AGE_MS < currentTime) {
    return {
      kind: "error",
      error: new CognitoAuthError(
        "AUTH_CALLBACK_TRANSACTION_EXPIRED",
        "로그인 요청이 만료되었습니다. 다시 로그인해 주세요.",
      ),
    };
  }

  const returnedState = url.searchParams.get("state");

  if (!returnedState || returnedState !== transaction.state) {
    return {
      kind: "error",
      error: new CognitoAuthError(
        "AUTH_CALLBACK_STATE_INVALID",
        "로그인 요청의 보안 확인값이 일치하지 않습니다.",
      ),
    };
  }

  if (authorizationError) {
    return {
      kind: "error",
      error: new CognitoAuthError(
        "AUTH_CALLBACK_ERROR",
        "Cognito 로그인 또는 가입이 완료되지 않았습니다.",
      ),
    };
  }

  if (!code) {
    return {
      kind: "error",
      error: new CognitoAuthError(
        "AUTH_CALLBACK_ERROR",
        "Cognito authorization code를 받지 못했습니다.",
      ),
    };
  }

  try {
    return {
      kind: "authenticated",
      session: await exchangeAuthorizationCode({
        code,
        transaction,
        config,
        fetcher,
        now: currentTime,
      }),
    };
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof CognitoAuthError
          ? error
          : new CognitoAuthError(
              "AUTH_TOKEN_EXCHANGE_FAILED",
              "Cognito와 로그인 정보를 교환하지 못했습니다.",
            ),
    };
  }
}

/** Cognito domain의 session cookie도 지우도록 logout endpoint URL을 만듭니다. */
export function createHostedUiLogoutUrl(config: CognitoAuthConfig) {
  const url = new URL("/logout", config.domain);

  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", config.logoutUri);

  return url.toString();
}

/** 만료된 메모리 세션의 access token을 API 호출에 전달하지 않습니다. */
export function getValidAccessToken(
  session: InMemoryAuthSession | null,
  now = Date.now(),
) {
  return session && session.expiresAt > now ? session.accessToken : null;
}

/** access token JWT exp(초)를 ms로 읽고, 없거나 잘못된 경우 fallback을 씁니다. */
export function resolveAccessTokenExpiresAt(
  accessToken: string,
  fallbackExpiresAt: number,
) {
  try {
    const claims = decodeJwtPayload(accessToken);
    const expiration = claims.exp;

    if (typeof expiration === "number" && Number.isFinite(expiration)) {
      return expiration * 1000;
    }
  } catch {
    // access token 디코드 실패 시 Cognito ExpiresIn 기반 fallback을 유지합니다.
  }

  return fallbackExpiresAt;
}

function isAuthenticatedUser(value: unknown): value is AuthenticatedUser {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    typeof record.username === "string" &&
    record.username.length > 0 &&
    Array.isArray(record.groups) &&
    record.groups.every((group) => typeof group === "string") &&
    (record.email === undefined || typeof record.email === "string") &&
    (record.displayName === undefined || typeof record.displayName === "string")
  );
}

function isInMemoryAuthSession(value: unknown): value is InMemoryAuthSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    isAuthenticatedUser(record.user)
  );
}

function parseStoredAuthSession(
  raw: string | null,
  storage: SessionStorageLike | null,
  now: number,
): InMemoryAuthSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isInMemoryAuthSession(parsed) || parsed.expiresAt <= now) {
      if (storage) {
        try {
          storage.removeItem(AUTH_SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
      }

      return null;
    }

    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      user: {
        sub: parsed.user.sub,
        username: parsed.user.username,
        groups: [...parsed.user.groups],
        ...(parsed.user.email ? { email: parsed.user.email } : {}),
        ...(parsed.user.displayName ? { displayName: parsed.user.displayName } : {}),
      },
    };
  } catch {
    if (storage) {
      try {
        storage.removeItem(AUTH_SESSION_STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    return null;
  }
}

function getLocalStorage(): SessionStorageLike | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage;
  } catch {
    return null;
  }
}

/** 탭 내 페이지 이동 후에도 로그인 상태를 복원합니다. */
export function readPersistedAuthSession(
  storage: SessionStorageLike,
  now = Date.now(),
): InMemoryAuthSession | null {
  const fromSession = parseStoredAuthSession(
    (() => {
      try {
        return storage.getItem(AUTH_SESSION_STORAGE_KEY);
      } catch {
        return null;
      }
    })(),
    storage,
    now,
  );

  if (fromSession) {
    rememberTabAuthSession(fromSession);
    return fromSession;
  }

  const local = getLocalStorage();

  if (!local || local === storage) {
    return null;
  }

  const fromLocal = parseStoredAuthSession(
    (() => {
      try {
        return local.getItem(AUTH_SESSION_STORAGE_KEY);
      } catch {
        return null;
      }
    })(),
    local,
    now,
  );

  if (fromLocal) {
    // sessionStorage가 비어 있으면 같은 탭 하드 이동용으로 다시 채웁니다.
    rememberTabAuthSession(fromLocal);

    try {
      storage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(fromLocal));
    } catch {
      // ignore
    }

    return fromLocal;
  }

  return null;
}

/** 로그인 성공·표시 이름 갱신 시 동일 탭 복원용으로 세션을 저장합니다. */
export function persistAuthSession(
  storage: SessionStorageLike,
  session: InMemoryAuthSession,
) {
  rememberTabAuthSession(session);
  const payload = JSON.stringify(session);

  try {
    storage.setItem(AUTH_SESSION_STORAGE_KEY, payload);
  } catch {
    // private mode 등에서 실패해도 탭 메모리·Context 세션은 유지합니다.
  }

  const local = getLocalStorage();

  if (local && local !== storage) {
    try {
      local.setItem(AUTH_SESSION_STORAGE_KEY, payload);
    } catch {
      // ignore
    }
  }
}

/** 로그아웃·만료·OAuth 실패 시 탭 복원용 세션을 제거합니다. */
export function clearPersistedAuthSession(storage: SessionStorageLike) {
  rememberTabAuthSession(null);

  try {
    storage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }

  const local = getLocalStorage();

  if (local && local !== storage) {
    try {
      local.removeItem(AUTH_SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
