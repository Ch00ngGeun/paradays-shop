// 역할: Hosted UI PKCE transaction 저장·회수와 authorize URL·callback URL 판별을 돕습니다.
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  CognitoAuthError,
  PKCE_TRANSACTION_STORAGE_KEY,
  type HostedUiFlow,
  type SessionStorageLike,
} from "@/lib/auth/cognito-client";

/** OIDC callback 전에만 sessionStorage에 남는 짧은 수명 값. */
export type PkceTransaction = Readonly<{
  verifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}>;

/** 앱의 등록 callback URL과 현재 URL의 origin·path가 같은지 확인합니다. */
export function isCallbackUrl(href: string, config: CognitoAuthConfig) {
  const currentUrl = new URL(href);
  const callbackUrl = new URL(config.redirectUri);

  return (
    currentUrl.origin === callbackUrl.origin &&
    currentUrl.pathname === callbackUrl.pathname
  );
}

/** 인증 URL 생성에 필요한 transaction을 sessionStorage에 안전하게 저장합니다. */
export function savePkceTransaction(
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
export function takePkceTransaction(storage: SessionStorageLike) {
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
export function buildAuthorizationUrl(
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
