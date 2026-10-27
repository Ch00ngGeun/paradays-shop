// 역할: Cognito Hosted UI 왕복 후 원래 보던 페이지로 되돌릴 경로를 sessionStorage에 보관합니다.

const RETURN_PATH_KEY = "paradays-auth-return-to";

const AUTH_PATH_PREFIXES = ["/login", "/signup", "/auth/callback"] as const;

/** 로그인·가입 화면이 아닌 앱 내부 path만 복귀 대상으로 허용합니다. */
export function isSafeAuthReturnPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  if (path.includes("://") || path.includes("\\")) {
    return false;
  }

  const pathname = path.split(/[?#]/, 1)[0] ?? path;

  return !AUTH_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** 현재 페이지(또는 전달 path)를 로그인 복귀 위치로 저장합니다. */
export function rememberAuthReturnPath(path?: string) {
  if (typeof window === "undefined") {
    return;
  }

  const candidate =
    path ??
    `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (!isSafeAuthReturnPath(candidate)) {
    return;
  }

  try {
    window.sessionStorage.setItem(RETURN_PATH_KEY, candidate);
  } catch {
    // 스토리지 차단 시에도 Cognito 이동은 계속합니다.
  }
}

/** 저장된 복귀 path를 한 번 읽고 지웁니다. 없거나 불안전하면 `/`입니다. */
export function consumeAuthReturnPath(fallback = "/") {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const stored = window.sessionStorage.getItem(RETURN_PATH_KEY);
    window.sessionStorage.removeItem(RETURN_PATH_KEY);

    if (stored && isSafeAuthReturnPath(stored)) {
      return stored;
    }
  } catch {
    // ignore
  }

  return fallback;
}
