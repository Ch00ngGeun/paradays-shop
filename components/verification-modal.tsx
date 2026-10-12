// 역할: 가입 또는 이메일 비밀번호 재설정의 인증 코드·새 비밀번호 단계를 표시합니다.
"use client";

import { useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import type { IdentityVerificationMethod } from "@/lib/auth/cognito-direct-auth";
import { isValidPassword } from "@/lib/auth/form-validation";

import styles from "./verification-modal.module.css";

export type VerificationModalMode = "signup" | "resetPassword";

type VerificationModalProps = {
  open: boolean;
  mode: VerificationModalMode;
  method: IdentityVerificationMethod;
  destinationLabel?: string;
  lead?: string;
  showNewPassword?: boolean;
  initialCodeRequested?: boolean;
  error?: string | null;
  info?: string | null;
  isSubmitting?: boolean;
  isSendDisabled?: boolean;
  resendNotice?: string;
  onClose: () => void;
  onSendCode: () => Promise<void>;
  onConfirm: (input: { code: string; newPassword?: string }) => Promise<void>;
};

/** 가입 확인과 비밀번호 재설정에서 공통 코드 입력 단계를 재사용합니다. */
export function VerificationModal({
  open,
  mode,
  method,
  destinationLabel,
  lead,
  showNewPassword = false,
  initialCodeRequested = false,
  error,
  info,
  isSubmitting = false,
  isSendDisabled = false,
  resendNotice,
  onClose,
  onSendCode,
  onConfirm,
}: VerificationModalProps) {
  const { copy } = useLocale();
  const modalLayer = useModalLayer(open);
  const dialogRef = useFocusTrap(Boolean(open && modalLayer), onClose);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [hasSent, setHasSent] = useState(initialCodeRequested);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);
  const isPasswordRecovery = mode === "resetPassword";
  const visibleError = localError ?? error;

  const title = mode === "signup" ? copy.authVerifyTitle : copy.authRecoveryCodeTitle;
  const defaultLead =
    method === "sms" ? copy.authVerifySmsLead : copy.authVerifyEmailLead;

  const handleSend = async () => {
    setLocalError(null);
    setIsResending(true);

    try {
      await onSendCode();
      setHasSent(true);
    } catch (caughtError) {
      setLocalError(
        isPasswordRecovery
          ? copy.authRecoveryTemporaryError
          : caughtError instanceof Error
            ? caughtError.message
            : copy.accountRequestFailed,
      );
    } finally {
      setIsResending(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);

    if (!code.trim()) {
      setLocalError(copy.authVerifyCodeRequired);
      return;
    }

    if (showNewPassword && !isValidPassword(newPassword)) {
      setLocalError(copy.authPasswordInvalid);
      return;
    }

    try {
      await onConfirm({
        code: code.trim(),
        ...(showNewPassword ? { newPassword } : {}),
      });
    } catch (caughtError) {
      setLocalError(
        isPasswordRecovery
          ? copy.authRecoveryCodeInvalid
          : caughtError instanceof Error
            ? caughtError.message
            : copy.accountRequestFailed,
      );
    }
  };

  if (!open || !modalLayer) {
    return null;
  }

  return createPortal(
    <div className={styles.overlay}>
      <button
        aria-hidden="true"
        className={styles.scrim}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-describedby="verification-modal-description"
        aria-labelledby="verification-modal-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef as RefObject<HTMLDivElement | null>}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 id="verification-modal-title" tabIndex={-1}>
            {title}
          </h2>
          <button
            aria-label={copy.close}
            className={styles.closeButton}
            onClick={onClose}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.lead} id="verification-modal-description">
            {lead ?? defaultLead}
          </p>
          {destinationLabel ? (
            <p className={styles.destination}>{destinationLabel}</p>
          ) : null}

          <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
            <button
              className={styles.secondary}
              disabled={isSubmitting || isResending || isSendDisabled}
              onClick={() => void handleSend()}
              type="button"
            >
              {hasSent ? copy.authVerifyResend : copy.authVerifySend}
            </button>

            <label>
              <span>{copy.authVerifyCode}</span>
              <input
                aria-describedby={visibleError ? "verification-modal-error" : undefined}
                aria-invalid={Boolean(visibleError)}
                autoComplete="one-time-code"
                data-autofocus
                inputMode="numeric"
                onChange={(event) => setCode(event.target.value)}
                value={code}
              />
            </label>

            {showNewPassword ? (
              <label>
                <span>{copy.authNewPassword}</span>
                <input
                  aria-describedby={
                    visibleError ? "verification-modal-error" : undefined
                  }
                  aria-invalid={Boolean(visibleError)}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  type="password"
                  value={newPassword}
                />
              </label>
            ) : null}

            {info ? (
              <p aria-live="polite" className={styles.info} role="status">
                {info}
              </p>
            ) : null}
            {isSendDisabled && resendNotice ? (
              <p aria-live="polite" className={styles.info} role="status">
                {resendNotice}
              </p>
            ) : null}
            {visibleError ? (
              <p className={styles.error} id="verification-modal-error" role="alert">
                {visibleError}
              </p>
            ) : null}

            <button
              className={styles.submit}
              disabled={isSubmitting || isResending}
              type="submit"
            >
              {mode === "signup" ? copy.authVerifySubmit : copy.authRecoveryConfirm}
            </button>
          </form>

          {/* Firebase invisible reCAPTCHA 컨테이너는 SMS 가입 단계에서만 사용합니다. */}
          {method === "sms" ? <div id="firebase-recaptcha" /> : null}
        </div>
      </div>
    </div>,
    modalLayer,
  );
}
