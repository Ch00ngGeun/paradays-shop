// 역할: 로그인 화면에서 Cognito 이메일 비밀번호 재설정을 시작하는 접근 가능한 모달입니다.
"use client";

import { useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import { isValidEmail, normalizeEmail } from "@/lib/auth/form-validation";

import styles from "./account-recovery-modal.module.css";

type AccountRecoveryModalProps = Readonly<{
  isCognitoAvailable: boolean;
  onClose: () => void;
  onRequestCode: (email: string) => Promise<"accepted" | "cooldown">;
}>;

/**
 * Cognito pool은 가입 이메일을 로그인 ID로 사용합니다.
 * 계정 존재 여부와 메일 전달 대상은 화면에 노출하지 않습니다.
 */
export function AccountRecoveryModal({
  isCognitoAvailable,
  onClose,
  onRequestCode,
}: AccountRecoveryModalProps) {
  const { copy } = useLocale();
  const modalLayer = useModalLayer(true);
  const dialogRef = useFocusTrap(Boolean(modalLayer), onClose);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
      setError(copy.authEmailInvalid);
      return;
    }

    if (!isCognitoAvailable) {
      setError(copy.authRecoveryCognitoUnavailable);
      return;
    }

    setIsSubmitting(true);

    try {
      const outcome = await onRequestCode(normalizedEmail);

      if (outcome === "cooldown") {
        setError(copy.authRecoveryCooldown);
      }
    } catch {
      // Provider 원문 오류와 계정 존재 여부는 복구 UI에 노출하지 않습니다.
      setError(copy.authRecoveryTemporaryError);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!modalLayer) {
    return null;
  }

  return createPortal(
    <div className={styles.overlay}>
      <button
        aria-hidden="true"
        className={styles.scrim}
        data-account-recovery-scrim
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-describedby="account-recovery-description"
        aria-labelledby="account-recovery-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef as RefObject<HTMLElement>}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 id="account-recovery-title" tabIndex={-1}>
            {copy.authRecoveryTitle}
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
          <p className={styles.lead} id="account-recovery-description">
            {copy.authRecoveryIdGuide}
          </p>
          <p className={styles.note} role="status">
            {copy.authRecoverySmsUnavailable}
          </p>
          {!isCognitoAvailable ? (
            <p className={styles.setupNotice} role="status">
              {copy.authRecoveryCognitoUnavailable}
            </p>
          ) : null}

          <form
            className={styles.form}
            noValidate
            onSubmit={(event) => void handleSubmit(event)}
          >
            <label className={styles.field}>
              <span>{copy.authEmail}</span>
              <input
                aria-describedby={error ? "account-recovery-email-error" : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="email"
                data-autofocus
                inputMode="email"
                name="recoveryEmail"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                value={email}
              />
            </label>

            {error ? (
              <p
                className={styles.error}
                id="account-recovery-email-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            <button
              className={styles.submit}
              disabled={isSubmitting || !isCognitoAvailable}
              type="submit"
            >
              {copy.authRecoveryRequest}
            </button>
          </form>
        </div>
      </section>
    </div>,
    modalLayer,
  );
}
