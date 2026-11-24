// 역할: AuthProvider가 쓰는 브라우저 저장소·주소창·Hosted UI 이동 도우미를 제공합니다.
import {
  createHostedUiAuthorizationUrl,
  removeHostedUiCallbackParameters,
  type HostedUiFlow,
  type SessionStorageLike,
} from "@/lib/auth/cognito-client";
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";

/** sessionStorage 접근이 차단된 브라우저에서는 로그인 시작을 안전하게 중단합니다. */
export function getSessionStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** callback code/state/error를 주소창에서 한 번만 지웁니다. */
export function clearCallbackQueryFromAddressBar() {
  const cleanPath = removeHostedUiCallbackParameters(window.location.href);

  window.history.replaceState(window.history.state, "", cleanPath);
}

/** Cognito UI로 이동할 공통 시작 함수입니다. */
export async function beginHostedUiFlow({
  flow,
  storage,
  config,
}: Readonly<{
  flow: HostedUiFlow;
  storage: SessionStorageLike;
  config: CognitoAuthConfig;
}>) {
  const authorizationUrl = await createHostedUiAuthorizationUrl({
    config,
    storage,
    flow,
  });

  window.location.assign(authorizationUrl);
}
