// 역할: AuthProvider의 이메일/비밀번호 직접 로그인·가입·코드 확인·비밀번호 재설정 콜백을 만듭니다.
"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";

import { CognitoAuthError, type InMemoryAuthSession } from "@/lib/auth/cognito-client";
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";
import {
  confirmForgotPassword,
  confirmSignUpWithCode,
  forgotPassword,
  resendSignUpConfirmationCode,
  signInWithPassword,
  signUpWithPassword,
} from "@/lib/auth/cognito-direct-auth";

import type { AuthActionResult } from "./auth-context";

/** AuthProvider 상태를 받아 직접 인증 콜백을 같은 순서의 useCallback으로 만듭니다. */
export function useDirectAuthActions({
  requireConfig,
  applySession,
  setError,
}: Readonly<{
  requireConfig: () => CognitoAuthConfig | null;
  applySession: (session: InMemoryAuthSession) => void;
  setError: Dispatch<SetStateAction<CognitoAuthError | null>>;
}>) {
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
    [applySession, requireConfig, setError],
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
    [requireConfig, setError],
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
    [requireConfig, setError],
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
    [requireConfig, setError],
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
    [requireConfig, setError],
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
    [requireConfig, setError],
  );

  return {
    signInDirect,
    signUpDirect,
    confirmSignUpDirect,
    resendSignUpCode,
    forgotPasswordDirect,
    confirmForgotPasswordDirect,
  };
}
