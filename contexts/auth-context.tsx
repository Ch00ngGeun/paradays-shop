// 역할: Cognito Hosted UI(PKCE) + 직접 SignUp/Confirm/Password 로그인 상태를 탭 내 공유·복원함.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  clearPersistedAuthSession,
  clearPkceTransaction,
  CognitoAuthError,
  completeHostedUiCallback,
  createHostedUiAuthorizationUrl,
  createHostedUiLogoutUrl,
  getValidAccessToken,
  persistAuthSession,
  readPersistedAuthSession,
  readTabAuthSession,
  rememberTabAuthSession,
  removeHostedUiCallbackParameters,
  type AuthenticatedUser,
  type HostedUiFlow,
  type InMemoryAuthSession,
  type SessionStorageLike,
} from "@/lib/auth/cognito-client";
import {
  getCognitoConfiguration,
  type CognitoAuthConfig,
} from "@/lib/auth/cognito-config";
import {
  confirmForgotPassword,
  confirmSignUpWithCode,
  forgotPassword,
  resendSignUpConfirmationCode,
  signInWithPassword,
  signUpWithPassword,
  type CodeDeliveryDetails,
  type SignUpDirectResult,
} from "@/lib/auth/cognito-direct-auth";
import { createMemberApiClientFromEnvironment } from "@/lib/commerce/member-api-client";

/** 화면이 표시할 수 있는 최소 인증 상태. */
export type AuthStatus = "initializing" | "anonymous" | "authenticated" | "unavailable";

/** 로그인·가입·로그아웃 클릭 결과를 예외 없이 UI에 전달합니다. */
export type AuthActionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: CognitoAuthError | Error }>;

type AuthContextValue = {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  error: CognitoAuthError | null;
  isAvailable: boolean;
  isAuthenticated: boolean;
  unavailableReason: string | null;
  /** 소셜·Hosted UI 로그인 */
  signIn: () => Promise<AuthActionResult>;
  /** 소셜·Hosted UI 가입 */
  signUp: () => Promise<AuthActionResult>;
  /** 이메일/비밀번호 직접 로그인 (Hosted UI 없이) */
  signInDirect: (email: string, password: string) => Promise<AuthActionResult>;
  /** 이메일/비밀번호 직접 가입 (확인 코드 단계로 이어짐) */
  signUpDirect: (input: {
    email: string;
    password: string;
    phoneNumber?: string;
    firebaseIdToken?: string;
  }) => Promise<
    | Readonly<{ ok: true; result: SignUpDirectResult }>
    | Readonly<{ ok: false; error: CognitoAuthError | Error }>
  >;
  confirmSignUpDirect: (email: string, code: string) => Promise<AuthActionResult>;
  resendSignUpCode: (
    email: string,
  ) => Promise<
    | Readonly<{ ok: true; codeDelivery?: CodeDeliveryDetails }>
    | Readonly<{ ok: false; error: CognitoAuthError | Error }>
  >;
  forgotPasswordDirect: (
    email: string,
  ) => Promise<
    | Readonly<{ ok: true; codeDelivery?: CodeDeliveryDetails }>
    | Readonly<{ ok: false; error: CognitoAuthError | Error }>
  >;
  confirmForgotPasswordDirect: (input: {
    email: string;
    code: string;
    newPassword: string;
  }) => Promise<AuthActionResult>;
  signOut: () => AuthActionResult;
  getAccessToken: () => string | null;
  /** 마이페이지 프로필 표시 이름을 헤더 등 공유 auth user에 반영합니다. */
  setUserDisplayName: (displayName: string | undefined) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** sessionStorage 접근이 차단된 브라우저에서는 로그인 시작을 안전하게 중단합니다. */
function getSessionStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** callback code/state/error를 주소창에서 한 번만 지웁니다. */
function clearCallbackQueryFromAddressBar() {
  const cleanPath = removeHostedUiCallbackParameters(window.location.href);

  window.history.replaceState(window.history.state, "", cleanPath);
}

/** Cognito UI로 이동할 공통 시작 함수입니다. */
async function beginHostedUiFlow({
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

/**
 * 인증 Provider.
 * 토큰은 동일 탭 이동·새로고침을 위해 sessionStorage(+localStorage 보조)·탭 메모리로 복원합니다.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const configuration = useMemo(() => getCognitoConfiguration(), []);
  const bootSession = typeof window === "undefined" ? null : readTabAuthSession();
  const sessionRef = useRef<InMemoryAuthSession | null>(bootSession);
  const initGenerationRef = useRef(0);
  const [status, setStatus] = useState<AuthStatus>(() => {
    if (!configuration.available) {
      return "unavailable";
    }

    // 탭 메모리만 동기 hydrate (sessionStorage는 hydration mismatch 방지를 위해 effect에서 복원)
    return bootSession ? "authenticated" : "initializing";
  });
  const [user, setUser] = useState<AuthenticatedUser | null>(
    () => bootSession?.user ?? null,
  );
  const [error, setError] = useState<CognitoAuthError | null>(null);

  const applySession = useCallback((session: InMemoryAuthSession) => {
    sessionRef.current = session;
    rememberTabAuthSession(session);
    setUser(session.user);
    setError(null);
    setStatus("authenticated");

    const storage = getSessionStorage();

    if (storage) {
      persistAuthSession(storage, session);
    }
  }, []);

  const clearSession = useCallback(
    (nextError: CognitoAuthError | null = null) => {
      sessionRef.current = null;
      rememberTabAuthSession(null);
      setUser(null);
      setError(nextError);
      setStatus(configuration.available ? "anonymous" : "unavailable");

      const storage = getSessionStorage();

      if (storage) {
        clearPersistedAuthSession(storage);
      }
    },
    [configuration.available],
  );

  // OAuth callback 우선 처리 후, 없으면 동일 탭에 저장된 세션을 복원합니다.
  useLayoutEffect(() => {
    if (!configuration.available) {
      return;
    }

    const config = configuration.config;
    const storage = getSessionStorage();
    const generation = ++initGenerationRef.current;

    if (!storage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- session restore must settle before paint; initGenerationRef guards async work.
      setStatus("anonymous");
      setError(
        new CognitoAuthError(
          "AUTH_PKCE_STORAGE_UNAVAILABLE",
          "현재 브라우저에서는 로그인 보안 저장소를 사용할 수 없습니다.",
        ),
      );
      return;
    }

    // 비동기 OAuth 처리 전에 저장된 세션을 먼저 붙여, 로그인 직후 remount 레이스를 막습니다.
    const earlyRestored = readTabAuthSession() ?? readPersistedAuthSession(storage);

    if (earlyRestored) {
      applySession(earlyRestored);
    }

    void (async () => {
      const result = await completeHostedUiCallback({
        href: window.location.href,
        config,
        storage,
      });

      if (generation !== initGenerationRef.current) {
        return;
      }

      if (result.kind === "authenticated") {
        applySession(result.session);
        clearCallbackQueryFromAddressBar();
        return;
      }

      if (result.kind === "error") {
        const existing = readTabAuthSession() ?? readPersistedAuthSession(storage);

        if (existing) {
          applySession(existing);
          clearCallbackQueryFromAddressBar();
          setError(result.error);
          return;
        }

        clearSession(result.error);
        clearCallbackQueryFromAddressBar();
        return;
      }

      const restored =
        readTabAuthSession() ?? readPersistedAuthSession(storage) ?? sessionRef.current;

      if (restored) {
        applySession(restored);
        return;
      }

      // 로그인 직후 다른 effect가 이미 authenticated면 덮어쓰지 않습니다.
      if (sessionRef.current || generation !== initGenerationRef.current) {
        return;
      }

      setUser(null);
      setStatus("anonymous");
      setError(null);
    })();
  }, [applySession, clearSession, configuration]);

  /** 로그인·가입 액션이 설정/저장소 미준비 상태에서 외부 이동하지 않게 합니다. */
  const startAuthentication = useCallback(
    async (flow: HostedUiFlow): Promise<AuthActionResult> => {
      if (!configuration.available) {
        const unavailableError = new CognitoAuthError(
          "AUTH_CALLBACK_ERROR",
          configuration.reason,
        );

        setError(unavailableError);

        return { ok: false, error: unavailableError };
      }

      const storage = getSessionStorage();

      if (!storage) {
        const storageError = new CognitoAuthError(
          "AUTH_PKCE_STORAGE_UNAVAILABLE",
          "현재 브라우저에서는 로그인 보안 저장소를 사용할 수 없습니다.",
        );

        setError(storageError);

        return { ok: false, error: storageError };
      }

      try {
        setError(null);
        await beginHostedUiFlow({ flow, storage, config: configuration.config });

        return { ok: true };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError(
                "AUTH_WEB_CRYPTO_UNAVAILABLE",
                "현재 브라우저에서 안전한 로그인 보안값을 생성할 수 없습니다.",
              );

        setError(authenticationError);

        return { ok: false, error: authenticationError };
      }
    },
    [configuration],
  );

  const requireConfig = useCallback(() => {
    if (!configuration.available) {
      const unavailableError = new CognitoAuthError(
        "AUTH_CALLBACK_ERROR",
        configuration.reason,
      );
      setError(unavailableError);
      return null;
    }

    return configuration.config;
  }, [configuration]);

  const signInDirect = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        const session = await signInWithPassword({ config, email, password });
        applySession(session);
        return { ok: true };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError("AUTH_DIRECT_FAILED", "로그인에 실패했습니다.");
        setError(authenticationError);
        return { ok: false, error: authenticationError };
      }
    },
    [applySession, requireConfig],
  );

  const signUpDirect = useCallback(
    async (input: {
      email: string;
      password: string;
      phoneNumber?: string;
      firebaseIdToken?: string;
    }) => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false as const,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        const result = await signUpWithPassword({
          config,
          email: input.email,
          password: input.password,
          phoneNumber: input.phoneNumber,
          firebaseIdToken: input.firebaseIdToken,
        });
        setError(null);
        return { ok: true as const, result };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError("AUTH_DIRECT_FAILED", "가입에 실패했습니다.");
        setError(authenticationError);
        return { ok: false as const, error: authenticationError };
      }
    },
    [requireConfig],
  );

  const confirmSignUpDirect = useCallback(
    async (email: string, code: string): Promise<AuthActionResult> => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        await confirmSignUpWithCode({ config, email, code });
        setError(null);
        return { ok: true };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError(
                "AUTH_DIRECT_FAILED",
                "인증 코드 확인에 실패했습니다.",
              );
        setError(authenticationError);
        return { ok: false, error: authenticationError };
      }
    },
    [requireConfig],
  );

  const resendSignUpCode = useCallback(
    async (email: string) => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false as const,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        const codeDelivery = await resendSignUpConfirmationCode({ config, email });
        setError(null);
        return { ok: true as const, codeDelivery };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError(
                "AUTH_DIRECT_FAILED",
                "인증 코드 재발송에 실패했습니다.",
              );
        setError(authenticationError);
        return { ok: false as const, error: authenticationError };
      }
    },
    [requireConfig],
  );

  const forgotPasswordDirect = useCallback(
    async (email: string) => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false as const,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        const codeDelivery = await forgotPassword({ config, email });
        setError(null);
        return { ok: true as const, codeDelivery };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError(
                "AUTH_DIRECT_FAILED",
                "비밀번호 재설정 코드를 보내지 못했습니다.",
              );

        // UserNotFound/NotAuthorized는 존재 여부 비공개를 위해 성공과 동일하게 취급합니다.
        if (authenticationError.code === "AUTH_DIRECT_NOT_AUTHORIZED") {
          setError(null);
          return { ok: true as const, codeDelivery: undefined };
        }

        // 복구 호출의 provider 원문은 전역 auth.error에도 보관하지 않습니다.
        // 호출측이 계정 존재·전달 대상과 무관한 안전한 문구로만 매핑합니다.
        setError(null);

        return { ok: false as const, error: authenticationError };
      }
    },
    [requireConfig],
  );

  const confirmForgotPasswordDirect = useCallback(
    async (input: {
      email: string;
      code: string;
      newPassword: string;
    }): Promise<AuthActionResult> => {
      const config = requireConfig();

      if (!config) {
        return {
          ok: false,
          error: new CognitoAuthError("AUTH_CALLBACK_ERROR", "Cognito 미설정"),
        };
      }

      try {
        await confirmForgotPassword({
          config,
          email: input.email,
          code: input.code,
          newPassword: input.newPassword,
        });
        setError(null);
        return { ok: true };
      } catch (caughtError) {
        const authenticationError =
          caughtError instanceof CognitoAuthError
            ? caughtError
            : new CognitoAuthError(
                "AUTH_DIRECT_FAILED",
                "비밀번호 재설정에 실패했습니다.",
              );
        // 복구 UI가 안전한 문구로 매핑하므로 전역 auth.error에 Cognito 원문을 남기지 않습니다.
        setError(null);
        return { ok: false, error: authenticationError };
      }
    },
    [requireConfig],
  );

  /** Cognito session cookie와 현재 페이지·탭 복원용 세션을 함께 비웁니다. */
  const signOut = useCallback((): AuthActionResult => {
    sessionRef.current = null;
    rememberTabAuthSession(null);
    setUser(null);
    setError(null);

    const storage = getSessionStorage();

    if (storage) {
      clearPkceTransaction(storage);
      clearPersistedAuthSession(storage);
    }

    if (!configuration.available) {
      setStatus("unavailable");

      return {
        ok: false,
        error: new CognitoAuthError("AUTH_CALLBACK_ERROR", configuration.reason),
      };
    }

    setStatus("anonymous");
    window.location.assign(createHostedUiLogoutUrl(configuration.config));

    return { ok: true };
  }, [configuration]);

  /** 만료 전 access token만 AWS API adapter가 요청할 수 있게 합니다. */
  const getAccessToken = useCallback(() => {
    const current = sessionRef.current;
    const accessToken = getValidAccessToken(current);

    if (!accessToken && current) {
      // 만료 시에만 삭제. 로그인 직후 remount 레이스로 null인 경우는 건드리지 않습니다.
      const storage = getSessionStorage();

      sessionRef.current = null;
      rememberTabAuthSession(null);
      setUser(null);
      setStatus("anonymous");

      if (storage) {
        clearPersistedAuthSession(storage);
      }
    }

    return accessToken;
  }, []);

  /** DynamoDB 프로필 표시 이름을 JWT name보다 우선해 헤더에 보여 줍니다. */
  const setUserDisplayName = useCallback((displayName: string | undefined) => {
    const normalized = displayName?.trim();

    if (!normalized) {
      return;
    }

    setUser((current) => {
      if (!current || current.displayName === normalized) {
        return current;
      }

      return { ...current, displayName: normalized };
    });

    const currentSession = sessionRef.current;

    if (currentSession && currentSession.user.displayName !== normalized) {
      const nextSession: InMemoryAuthSession = {
        ...currentSession,
        user: { ...currentSession.user, displayName: normalized },
      };
      sessionRef.current = nextSession;

      const storage = getSessionStorage();

      if (storage) {
        persistAuthSession(storage, nextSession);
      }
    }
  }, []);

  // 로그인 직후 프로필 표시 이름을 불러와 상단 계정 표시에 반영합니다.
  useEffect(() => {
    if (status !== "authenticated" || !configuration.available) {
      return;
    }

    let isCurrent = true;

    void (async () => {
      try {
        const memberApi = createMemberApiClientFromEnvironment({
          authorizationTokenProvider: { getAccessToken },
        });
        const profile = await memberApi.getProfile();

        if (isCurrent && profile.displayName) {
          setUserDisplayName(profile.displayName);
        }
      } catch {
        // 프로필 조회 실패 시 JWT email/name으로 헤더를 유지합니다.
      }
    })();

    return () => {
      isCurrent = false;
    };
  }, [configuration.available, getAccessToken, setUserDisplayName, status]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      error,
      isAvailable: configuration.available,
      isAuthenticated: status === "authenticated",
      unavailableReason: configuration.available ? null : configuration.reason,
      signIn: () => startAuthentication("signIn"),
      signUp: () => startAuthentication("signUp"),
      signInDirect,
      signUpDirect,
      confirmSignUpDirect,
      resendSignUpCode,
      forgotPasswordDirect,
      confirmForgotPasswordDirect,
      signOut,
      getAccessToken,
      setUserDisplayName,
    }),
    [
      configuration,
      confirmForgotPasswordDirect,
      confirmSignUpDirect,
      error,
      forgotPasswordDirect,
      getAccessToken,
      resendSignUpCode,
      setUserDisplayName,
      signInDirect,
      signOut,
      signUpDirect,
      startAuthentication,
      status,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** AuthProvider 하위의 헤더·계정·결제 UI에서 인증 상태와 액션을 읽습니다. */
export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }

  return context;
}
