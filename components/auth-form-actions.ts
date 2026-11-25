// 역할: AuthForm의 제출·소셜 로그인·인증 코드·비밀번호 복구 처리 함수를 만듭니다.
import type { Dispatch, FormEvent, SetStateAction } from "react";

import type { useAuth } from "@/contexts/auth-context";
import type { useLocale } from "@/contexts/locale-context";
import { saveConsentReceipt } from "@/lib/auth/consent";
import {
  isValidKoreanPhoneNumber,
  type IdentityVerificationMethod,
} from "@/lib/auth/cognito-direct-auth";
import {
  confirmFirebaseSmsCode,
  sendFirebaseSmsCode,
} from "@/lib/auth/firebase-phone-auth";
import { CognitoAuthError } from "@/lib/auth/cognito-client";
import {
  isValidEmail,
  isValidLoginIdentifier,
  isValidPassword,
  normalizeEmail,
  normalizeLoginIdentifier,
  passwordsMatch,
} from "@/lib/auth/form-validation";

import type { VerificationModalMode } from "./verification-modal";

type AuthApi = ReturnType<typeof useAuth>;

export type FieldErrors = {
  identifier?: string;
  password?: string;
  confirmPassword?: string;
  phone?: string;
  terms?: string;
};

export type ModalState = {
  open: boolean;
  mode: VerificationModalMode;
  method: IdentityVerificationMethod;
};

/** 복구 코드 반복 발송을 짧게 제한해 계정 복구 엔드포인트 남용을 줄입니다. */
const RECOVERY_RESEND_COOLDOWN_MS = 60_000;

export function createAuthSubmitActions({
  mode,
  copy,
  isAvailable,
  signIn,
  signUp,
  signInDirect,
  identifier,
  password,
  confirmPassword,
  phone,
  identityMethod,
  agreeTerms,
  agreePrivacy,
  agreeAge,
  marketingOptIn,
  setTouched,
  setSubmitError,
  setInfoMessage,
  setIsSubmitting,
  markTouched,
  finishAuthenticated,
  openVerificationModal,
}: Readonly<{
  mode: "login" | "signup";
  copy: ReturnType<typeof useLocale>["copy"];
  isAvailable: boolean;
  signIn: AuthApi["signIn"];
  signUp: AuthApi["signUp"];
  signInDirect: AuthApi["signInDirect"];
  identifier: string;
  password: string;
  confirmPassword: string;
  phone: string;
  identityMethod: IdentityVerificationMethod;
  agreeTerms: boolean;
  agreePrivacy: boolean;
  agreeAge: boolean;
  marketingOptIn: boolean;
  setTouched: Dispatch<SetStateAction<Record<string, boolean>>>;
  setSubmitError: Dispatch<SetStateAction<string | null>>;
  setInfoMessage: Dispatch<SetStateAction<string | null>>;
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  markTouched: (field: string) => void;
  finishAuthenticated: () => Promise<void>;
  openVerificationModal: (
    modalMode: VerificationModalMode,
    method: IdentityVerificationMethod,
  ) => void;
}>) {
  const validateSignupForm = () => {
    setTouched({
      identifier: true,
      password: true,
      confirmPassword: true,
      phone: identityMethod === "sms",
      terms: true,
    });

    if (!isValidEmail(identifier)) {
      return false;
    }

    const phoneOk = identityMethod === "email" || isValidKoreanPhoneNumber(phone);

    return (
      isValidPassword(password) &&
      passwordsMatch(password, confirmPassword) &&
      agreeTerms &&
      agreePrivacy &&
      agreeAge &&
      phoneOk
    );
  };

  const handleLoginSubmit = async () => {
    const result = await signInDirect(normalizeLoginIdentifier(identifier), password);

    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }

    await finishAuthenticated();
  };

  const handleSignupSubmit = async () => {
    if (!validateSignupForm()) {
      return;
    }

    if (!isAvailable) {
      setSubmitError(copy.accountUnavailable);
      return;
    }

    saveConsentReceipt({
      marketingEmail: marketingOptIn,
      marketingSms: marketingOptIn,
      marketingPush: marketingOptIn,
    });

    openVerificationModal("signup", identityMethod);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setInfoMessage(null);

    if (mode === "login") {
      setTouched({ identifier: true, password: true });

      if (!isValidLoginIdentifier(identifier) || password.length === 0) {
        return;
      }

      if (!isAvailable) {
        setSubmitError(copy.accountUnavailable);
        return;
      }

      setIsSubmitting(true);

      try {
        await handleLoginSubmit();
      } catch (caughtError) {
        setSubmitError(
          caughtError instanceof Error
            ? caughtError.message
            : copy.accountRequestFailed,
        );
      } finally {
        setIsSubmitting(false);
      }

      return;
    }

    setIsSubmitting(true);

    try {
      await handleSignupSubmit();
    } catch (caughtError) {
      setSubmitError(
        caughtError instanceof Error ? caughtError.message : copy.accountRequestFailed,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const startSocial = async () => {
    setSubmitError(null);

    if (!isAvailable) {
      setSubmitError(copy.accountUnavailable);
      return;
    }

    if (mode === "signup" && !(agreeTerms && agreePrivacy && agreeAge)) {
      markTouched("terms");
      setSubmitError(copy.authTermsRequired);
      return;
    }

    if (mode === "signup") {
      saveConsentReceipt({
        marketingEmail: marketingOptIn,
        marketingSms: marketingOptIn,
        marketingPush: marketingOptIn,
      });
    }

    setIsSubmitting(true);
    const result = mode === "login" ? await signIn() : await signUp();
    setIsSubmitting(false);

    if (!result.ok) {
      setSubmitError(result.error.message);
    }
  };

  return { handleSubmit, startSocial };
}

export function createAuthVerificationActions({
  copy,
  isAvailable,
  signInDirect,
  signUpDirect,
  confirmSignUpDirect,
  resendSignUpCode,
  forgotPasswordDirect,
  confirmForgotPasswordDirect,
  identifier,
  password,
  phone,
  setInfoMessage,
  setIsSubmitting,
  modal,
  setModal,
  setModalInfo,
  setIsRecoveryModalOpen,
  recoveryEmail,
  setRecoveryEmail,
  recoveryCooldownUntil,
  setRecoveryCooldownUntil,
  emailSignupStarted,
  setEmailSignupStarted,
  finishAuthenticated,
  openVerificationModal,
  closeVerificationModal,
}: Readonly<{
  copy: ReturnType<typeof useLocale>["copy"];
  isAvailable: boolean;
  signInDirect: AuthApi["signInDirect"];
  signUpDirect: AuthApi["signUpDirect"];
  confirmSignUpDirect: AuthApi["confirmSignUpDirect"];
  resendSignUpCode: AuthApi["resendSignUpCode"];
  forgotPasswordDirect: AuthApi["forgotPasswordDirect"];
  confirmForgotPasswordDirect: AuthApi["confirmForgotPasswordDirect"];
  identifier: string;
  password: string;
  phone: string;
  setInfoMessage: Dispatch<SetStateAction<string | null>>;
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  modal: ModalState;
  setModal: Dispatch<SetStateAction<ModalState>>;
  setModalInfo: Dispatch<SetStateAction<string | null>>;
  setIsRecoveryModalOpen: Dispatch<SetStateAction<boolean>>;
  recoveryEmail: string | null;
  setRecoveryEmail: Dispatch<SetStateAction<string | null>>;
  recoveryCooldownUntil: number | null;
  setRecoveryCooldownUntil: Dispatch<SetStateAction<number | null>>;
  emailSignupStarted: boolean;
  setEmailSignupStarted: Dispatch<SetStateAction<boolean>>;
  finishAuthenticated: () => Promise<void>;
  openVerificationModal: (
    modalMode: VerificationModalMode,
    method: IdentityVerificationMethod,
  ) => void;
  closeVerificationModal: () => void;
}>) {
  const startPasswordRecovery = async (email: string) => {
    if (!isAvailable) {
      throw new Error(copy.authRecoveryCognitoUnavailable);
    }

    if (recoveryCooldownUntil) {
      return "cooldown" as const;
    }

    const result = await forgotPasswordDirect(email);

    if (
      !result.ok &&
      !(
        result.error instanceof CognitoAuthError &&
        result.error.code === "AUTH_DIRECT_NOT_AUTHORIZED"
      )
    ) {
      throw new Error(copy.authRecoveryTemporaryError);
    }

    setRecoveryEmail(email);
    setRecoveryCooldownUntil(RECOVERY_RESEND_COOLDOWN_MS);
    setIsRecoveryModalOpen(false);
    openVerificationModal("resetPassword", "email");
    setModalInfo(copy.authRecoveryRequestAccepted);
    return "accepted" as const;
  };

  const resendPasswordRecoveryCode = async () => {
    if (!recoveryEmail) {
      throw new Error(copy.authRecoveryTemporaryError);
    }

    if (recoveryCooldownUntil) {
      setModalInfo(copy.authRecoveryCooldown);
      return;
    }

    const result = await forgotPasswordDirect(recoveryEmail);

    if (
      !result.ok &&
      !(
        result.error instanceof CognitoAuthError &&
        result.error.code === "AUTH_DIRECT_NOT_AUTHORIZED"
      )
    ) {
      throw new Error(copy.authRecoveryTemporaryError);
    }

    setRecoveryCooldownUntil(RECOVERY_RESEND_COOLDOWN_MS);
    setModalInfo(copy.authRecoveryRequestAccepted);
  };

  const handleSendCode = async () => {
    if (modal.method === "sms") {
      if (modal.mode !== "signup") {
        throw new Error(copy.authRecoveryTemporaryError);
      }

      await sendFirebaseSmsCode({ phoneNumber: phone });
      setModalInfo(copy.authVerifySent);
      return;
    }

    if (modal.mode === "signup") {
      const email = normalizeEmail(identifier);

      if (emailSignupStarted) {
        const resent = await resendSignUpCode(email);

        if (!resent.ok) {
          throw resent.error;
        }

        setModalInfo(copy.authVerifySent);
        return;
      }

      const signUpResult = await signUpDirect({
        email,
        password,
      });

      if (!signUpResult.ok) {
        throw signUpResult.error;
      }

      setEmailSignupStarted(true);

      if (signUpResult.result.userConfirmed) {
        const loginResult = await signInDirect(email, password);

        if (!loginResult.ok) {
          throw loginResult.error;
        }

        closeVerificationModal();
        await finishAuthenticated();
        return;
      }

      setModalInfo(copy.authVerifySent);
      return;
    }

    await resendPasswordRecoveryCode();
  };

  const handleConfirmCode = async (input: { code: string; newPassword?: string }) => {
    setIsSubmitting(true);

    try {
      if (modal.mode === "signup") {
        if (modal.method === "sms") {
          const sms = await confirmFirebaseSmsCode(input.code);
          const email = normalizeEmail(identifier);
          const signUpResult = await signUpDirect({
            email,
            password,
            phoneNumber: phone,
            firebaseIdToken: sms.idToken,
          });

          if (!signUpResult.ok) {
            throw signUpResult.error;
          }

          if (!signUpResult.result.userConfirmed) {
            // PreSignUp 미배포 시 이메일 코드로 폴백
            setModal({ open: true, mode: "signup", method: "email" });
            setModalInfo(copy.authVerifyEmailFallback);
            return;
          }

          const loginResult = await signInDirect(email, password);

          if (!loginResult.ok) {
            throw loginResult.error;
          }

          closeVerificationModal();
          await finishAuthenticated();
          return;
        }

        // 이메일 가입 확인: 인증 코드로 가입을 확정한 뒤 바로 로그인합니다.
        const email = normalizeEmail(identifier);
        const confirmResult = await confirmSignUpDirect(email, input.code);

        if (!confirmResult.ok) {
          throw confirmResult.error;
        }

        const loginResult = await signInDirect(email, password);

        if (!loginResult.ok) {
          throw loginResult.error;
        }

        closeVerificationModal();
        await finishAuthenticated();
        return;
      }

      if (!recoveryEmail || !input.newPassword) {
        throw new Error(copy.authRecoveryCodeInvalid);
      }

      const confirmResult = await confirmForgotPasswordDirect({
        email: recoveryEmail,
        code: input.code,
        newPassword: input.newPassword,
      });

      if (!confirmResult.ok) {
        if (
          confirmResult.error instanceof CognitoAuthError &&
          confirmResult.error.code === "AUTH_DIRECT_INVALID_PASSWORD"
        ) {
          throw new Error(copy.authPasswordInvalid);
        }

        throw new Error(copy.authRecoveryCodeInvalid);
      }

      setRecoveryEmail(null);
      setRecoveryCooldownUntil(null);
      setInfoMessage(copy.authPasswordResetDone);
      closeVerificationModal();
    } finally {
      setIsSubmitting(false);
    }
  };

  return { startPasswordRecovery, handleSendCode, handleConfirmCode };
}
