// 역할: 브라우저용 Cognito Hosted UI 공개 설정을 검증하고 안전한 OAuth 엔드포인트 값을 만듭니다.

/** Cognito public app client가 브라우저에 노출해도 되는 공개 설정값. */
export type CognitoAuthConfig = Readonly<{
  domain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
  scopes: readonly string[];
  issuer?: string;
}>;

/** 빌드 시 주입되는 공개 환경 변수의 테스트 가능한 형태. */
export type CognitoPublicEnvironment = Readonly<{
  domain?: string;
  clientId?: string;
  redirectUri?: string;
  logoutUri?: string;
  scopes?: string;
  issuer?: string;
}>;

/** 설정 누락 시 UI가 안전하게 비활성 상태를 표시할 수 있는 결과. */
export type CognitoConfiguration =
  | Readonly<{ available: true; config: CognitoAuthConfig }>
  | Readonly<{ available: false; reason: string }>;

/** OIDC 사용자 정보와 API Gateway가 access token만 받게 하는 PARADAYS commerce 권한의 기본값. */
const DEFAULT_SCOPES = ["openid", "email", "profile", "paradays-commerce/api"] as const;

/** Next.js가 브라우저 번들에 인라인하는 공개 Cognito 변수만 읽습니다. */
function readPublicEnvironment(): CognitoPublicEnvironment {
  return {
    domain: process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
    clientId: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
    redirectUri: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI,
    logoutUri: process.env.NEXT_PUBLIC_COGNITO_LOGOUT_URI,
    scopes: process.env.NEXT_PUBLIC_COGNITO_SCOPES,
    issuer: process.env.NEXT_PUBLIC_COGNITO_ISSUER,
  };
}

/** 빈 값과 앞뒤 공백을 설정 누락으로 정규화합니다. */
function getRequiredValue(value: string | undefined) {
  const normalizedValue = value?.trim();

  return normalizedValue ? normalizedValue : null;
}

/** Cognito 도메인은 HTTPS origin만 허용해 잘못된 엔드포인트 전송을 막습니다. */
function normalizeCognitoDomain(value: string) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

/** callback/logout URL은 HTTPS 또는 로컬 개발용 HTTP URL만 허용합니다. */
function normalizeApplicationUrl(value: string) {
  try {
    const url = new URL(value);
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");

    if (url.hash || (url.protocol !== "https:" && !isLocalHttp)) {
      return null;
    }

    // Cognito allowlist는 trailing slash 유무를 엄격히 구분하므로 origin만 쓸 때는 slash를 제거합니다.
    if (url.pathname === "/" && !url.search) {
      return url.origin;
    }

    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** issuer 검증을 선택한 경우 URL 형식만 받아 이후 ID token 검사에 사용합니다. */
function normalizeIssuer(value: string | undefined) {
  const issuer = getRequiredValue(value);

  if (!issuer) {
    return undefined;
  }

  try {
    const url = new URL(issuer);

    if (url.protocol !== "https:" || url.search || url.hash) {
      return null;
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** 공백·중복을 제거하고 OIDC ID token용 openid scope를 항상 요청합니다. */
function normalizeScopes(scopesValue: string | undefined) {
  const requestedScopes = scopesValue
    ? scopesValue.split(/[\s,]+/).filter(Boolean)
    : [...DEFAULT_SCOPES];
  const scopes = [...new Set(requestedScopes)];

  if (!scopes.includes("openid")) {
    scopes.unshift("openid");
  }

  return scopes;
}

/**
 * Cognito 환경 변수를 검증합니다.
 * public app client ID는 공개값이지만 client secret은 어떤 경우에도 받거나 저장하지 않습니다.
 */
export function getCognitoConfiguration(
  environment: CognitoPublicEnvironment = readPublicEnvironment(),
): CognitoConfiguration {
  const domainValue = getRequiredValue(environment.domain);
  const clientId = getRequiredValue(environment.clientId);
  const redirectUriValue = getRequiredValue(environment.redirectUri);

  if (!domainValue || !clientId || !redirectUriValue) {
    return {
      available: false,
      reason:
        "Cognito 공개 설정이 아직 준비되지 않았습니다. 도메인, public client ID, callback URL을 설정하세요.",
    };
  }

  const domain = normalizeCognitoDomain(domainValue);
  const redirectUri = normalizeApplicationUrl(redirectUriValue);
  const logoutUriValue = getRequiredValue(environment.logoutUri) ?? redirectUriValue;
  const logoutUri = normalizeApplicationUrl(logoutUriValue);
  const issuer = normalizeIssuer(environment.issuer);

  if (!domain) {
    return {
      available: false,
      reason: "Cognito 도메인은 경로·쿼리 없는 HTTPS URL이어야 합니다.",
    };
  }

  if (!redirectUri || !logoutUri) {
    return {
      available: false,
      reason:
        "Cognito callback/logout URL은 HTTPS 또는 localhost HTTP URL이어야 합니다.",
    };
  }

  if (issuer === null) {
    return {
      available: false,
      reason: "Cognito issuer URL 형식이 올바르지 않습니다.",
    };
  }

  return {
    available: true,
    config: {
      domain,
      clientId,
      redirectUri,
      logoutUri,
      scopes: normalizeScopes(environment.scopes),
      ...(issuer ? { issuer } : {}),
    },
  };
}
