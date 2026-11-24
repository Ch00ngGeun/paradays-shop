// 역할: 로그인·회원가입과 Cognito 이메일 기반 비밀번호 재설정을 제공합니다.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import type { LegalDocumentId } from "@/data/legal-terms";
import {
  isValidKoreanPhoneNumber,
  type IdentityVerificationMethod,
} from "@/lib/auth/cognito-direct-auth";
import { clearFirebaseAuthSession } from "@/lib/auth/firebase-phone-auth";
import {
  getPasswordRuleStates,
  isValidEmail,
  isValidLoginIdentifier,
  isValidPassword,
  normalizeEmail,
  passwordsMatch,
} from "@/lib/auth/form-validation";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

import { AccountRecoveryModal } from "./account-recovery-modal";
import { TermsModal } from "./terms-modal";
import { VerificationModal, type VerificationModalMode } from "./verification-modal";
import styles from "./auth-form.module.css";
import {
  createAuthSubmitActions,
  createAuthVerificationActions,
  type FieldErrors,
  type ModalState,
} from "./auth-form-actions";
import { AuthSignupFields } from "./auth-form-fields";

type AuthFormMode = "login" | "signup";

type AuthFormProps = {
  mode: AuthFormMode;
};

/** `/login`·`/signup` 본문. */
export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { copy } = useLocale();
  const {
    isAuthenticated,
    isAvailable,
    signIn,
    signUp,
    signInDirect,
    signUpDirect,
    confirmSignUpDirect,
    resendSignUpCode,
    forgotPasswordDirect,
    confirmForgotPasswordDirect,
    status,
    user,
  } = useAuth();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [identityMethod, setIdentityMethod] =
    useState<IdentityVerificationMethod>("email");
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const [agreeAge, setAgreeAge] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<LegalDocumentId | null>(null);
  const [modal, setModal] = useState<ModalState>({
    open: false,
    mode: "signup",
    method: "email",
  });
  const [modalInfo, setModalInfo] = useState<string | null>(null);
  const [isRecoveryModalOpen, setIsRecoveryModalOpen] = useState(false);
  /** 최초 코드 요청 뒤에도 재발송·확인에만 사용하는 정규화된 이메일입니다. */
  const [recoveryEmail, setRecoveryEmail] = useState<string | null>(null);
  const [recoveryCooldownUntil, setRecoveryCooldownUntil] = useState<number | null>(
    null,
  );
  const [emailSignupStarted, setEmailSignupStarted] = useState(false);

  const passwordRules = useMemo(() => getPasswordRuleStates(password), [password]);

  const fieldErrors = useMemo<FieldErrors>(() => {
    const errors: FieldErrors = {};

    if (touched.identifier) {
      if (mode === "login") {
        if (!isValidLoginIdentifier(identifier)) {
          errors.identifier = copy.authLoginIdInvalid;
        }
      } else if (!isValidEmail(identifier)) {
        errors.identifier = copy.authEmailInvalid;
      }
    }

    if (mode === "signup") {
      if (touched.password && !isValidPassword(password)) {
        errors.password = copy.authPasswordInvalid;
      }

      if (touched.confirmPassword && !passwordsMatch(password, confirmPassword)) {
        errors.confirmPassword = copy.authPasswordMismatch;
      }

      if (
        touched.phone &&
        identityMethod === "sms" &&
        !isValidKoreanPhoneNumber(phone)
      ) {
        errors.phone = copy.authPhoneInvalid;
      }

      if (touched.terms && !(agreeTerms && agreePrivacy && agreeAge)) {
        errors.terms = copy.authTermsRequired;
      }
    } else if (touched.password && password.length === 0) {
      errors.password = copy.authPasswordRequired;
    }

    return errors;
  }, [
    agreeAge,
    agreePrivacy,
    agreeTerms,
    confirmPassword,
    copy,
    identifier,
    identityMethod,
    mode,
    password,
    phone,
    touched,
  ]);

  useEffect(() => {
    if (recoveryCooldownUntil === null) {
      return;
    }

    const timeout = window.setTimeout(
      () => setRecoveryCooldownUntil(null),
      recoveryCooldownUntil,
    );

    return () => window.clearTimeout(timeout);
  }, [recoveryCooldownUntil]);

  if (status === "initializing") {
    return <p className={styles.status}>{copy.accountLoading}</p>;
  }

  if (isAuthenticated && user) {
    const isAdmin = user.groups.includes("admin");

    return (
      <section className={styles.panel}>
        <h1>{copy.authAlreadySignedIn}</h1>
        <p>{user.email ?? user.username}</p>
        {isAdmin ? (
          <Link className={styles.primaryLink} href="/admin">
            {copy.authContinueToAdmin}
          </Link>
        ) : (
          <Link className={styles.primaryLink} href="/account">
            {copy.account}
          </Link>
        )}
      </section>
    );
  }

  const markTouched = (field: string) => {
    setTouched((current) => ({ ...current, [field]: true }));
  };

  const finishAuthenticated = async () => {
    await clearFirebaseAuthSession();
    // refresh()는 static export에서 Provider를 다시 마운트하며 방금 저장한 세션과 레이스할 수 있어 쓰지 않습니다.
    router.replace(consumeAuthReturnPath("/"));
  };

  const openVerificationModal = (
    modalMode: VerificationModalMode,
    method: IdentityVerificationMethod,
  ) => {
    setModalInfo(null);
    if (modalMode === "signup") {
      setEmailSignupStarted(false);
    }
    setModal({ open: true, mode: modalMode, method });
  };

  const closeVerificationModal = () => {
    setModal((current) => ({ ...current, open: false }));
    setModalInfo(null);
  };

  const { handleSubmit, startSocial } = createAuthSubmitActions({
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
  });
  const { startPasswordRecovery, handleSendCode, handleConfirmCode } =
    createAuthVerificationActions({
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
    });

  const handleResendInModal = async () => {
    await handleSendCode();
  };

  const openRecoveryModal = () => {
    setSubmitError(null);
    setInfoMessage(null);
    setIsRecoveryModalOpen(true);
  };

  const modalDestination =
    modal.mode === "signup"
      ? modal.method === "sms"
        ? phone
        : normalizeEmail(identifier)
      : undefined;

  return (
    <section className={styles.panel} aria-labelledby="auth-form-title">
      <h1 id="auth-form-title">
        {mode === "login" ? copy.loginTitle : copy.signUpTitle}
      </h1>
      <p className={styles.lead}>
        {mode === "login" ? copy.loginLead : copy.signUpLead}
      </p>

      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => void handleSubmit(event)}
      >
        <label>
          <span>{mode === "login" ? copy.authLoginId : copy.authEmail}</span>
          <input
            autoComplete={mode === "login" ? "username" : "email"}
            inputMode={mode === "login" ? "text" : "email"}
            name={mode === "login" ? "username" : "email"}
            onBlur={() => markTouched("identifier")}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={mode === "login" ? copy.authLoginIdPlaceholder : undefined}
            type={mode === "login" ? "text" : "email"}
            value={identifier}
          />
          {fieldErrors.identifier ? <em>{fieldErrors.identifier}</em> : null}
        </label>

        <label>
          <span>{copy.authPassword}</span>
          <input
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            name="password"
            onBlur={() => markTouched("password")}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          {fieldErrors.password ? <em>{fieldErrors.password}</em> : null}
        </label>

        {mode === "signup" ? (
          <AuthSignupFields
            copy={copy}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            phone={phone}
            setPhone={setPhone}
            identityMethod={identityMethod}
            setIdentityMethod={setIdentityMethod}
            agreeTerms={agreeTerms}
            setAgreeTerms={setAgreeTerms}
            agreePrivacy={agreePrivacy}
            setAgreePrivacy={setAgreePrivacy}
            agreeAge={agreeAge}
            setAgreeAge={setAgreeAge}
            marketingOptIn={marketingOptIn}
            setMarketingOptIn={setMarketingOptIn}
            setOpenDocumentId={setOpenDocumentId}
            passwordRules={passwordRules}
            fieldErrors={fieldErrors}
            markTouched={markTouched}
          />
        ) : null}

        {infoMessage ? <p className={styles.hint}>{infoMessage}</p> : null}
        {submitError ? (
          <p className={styles.error} role="alert">
            {submitError}
          </p>
        ) : null}

        <button className={styles.submit} disabled={isSubmitting} type="submit">
          {mode === "login" ? copy.loginSubmit : copy.signUpSubmit}
        </button>
      </form>

      {mode === "login" ? (
        <div className={styles.recovery}>
          <button
            aria-expanded={isRecoveryModalOpen}
            aria-haspopup="dialog"
            className={styles.recoveryTrigger}
            onClick={openRecoveryModal}
            type="button"
          >
            {copy.authRecoveryAction}
          </button>
        </div>
      ) : null}

      <div className={styles.social}>
        <p>{copy.authSocialLead}</p>
        <div className={styles.socialActions}>
          {(["Google", "Kakao", "Naver", "Apple"] as const).map((provider) => (
            <button
              disabled={isSubmitting}
              key={provider}
              onClick={() => void startSocial()}
              type="button"
            >
              {provider}
            </button>
          ))}
        </div>
        <p className={styles.hint}>{copy.authCognitoHint}</p>
      </div>

      <p className={styles.switch}>
        {mode === "login" ? (
          <>
            {copy.authNeedAccount} <Link href="/signup">{copy.signUp}</Link>
          </>
        ) : (
          <>
            {copy.authHaveAccount} <Link href="/login">{copy.signIn}</Link>
          </>
        )}
      </p>

      <TermsModal documentId={openDocumentId} onClose={() => setOpenDocumentId(null)} />

      {isRecoveryModalOpen ? (
        <AccountRecoveryModal
          isCognitoAvailable={isAvailable}
          onClose={() => setIsRecoveryModalOpen(false)}
          onRequestCode={startPasswordRecovery}
        />
      ) : null}

      <VerificationModal
        initialCodeRequested={modal.mode === "resetPassword"}
        isSendDisabled={
          modal.mode === "resetPassword" && recoveryCooldownUntil !== null
        }
        key={`verification-${modal.open}-${modal.mode}-${modal.method}`}
        destinationLabel={modalDestination}
        lead={
          modal.mode === "resetPassword" ? copy.authRecoveryRequestAccepted : undefined
        }
        info={modalInfo}
        isSubmitting={isSubmitting}
        method={modal.method}
        mode={modal.mode}
        onClose={closeVerificationModal}
        onConfirm={handleConfirmCode}
        onSendCode={handleResendInModal}
        open={modal.open}
        resendNotice={
          modal.mode === "resetPassword" && recoveryCooldownUntil !== null
            ? copy.authRecoveryCooldown
            : undefined
        }
        showNewPassword={modal.mode === "resetPassword"}
      />
    </section>
  );
}
