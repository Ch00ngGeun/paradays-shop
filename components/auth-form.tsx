// 역할: 로그인·회원가입과 Cognito 이메일 기반 비밀번호 재설정을 제공합니다.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import type { LegalDocumentId } from "@/data/legal-terms";
import { saveConsentReceipt } from "@/lib/auth/consent";
import {
  isValidKoreanPhoneNumber,
  type IdentityVerificationMethod,
} from "@/lib/auth/cognito-direct-auth";
import {
  clearFirebaseAuthSession,
  confirmFirebaseSmsCode,
  sendFirebaseSmsCode,
} from "@/lib/auth/firebase-phone-auth";
import { CognitoAuthError } from "@/lib/auth/cognito-client";
import {
  getPasswordRuleStates,
  isValidEmail,
  isValidLoginIdentifier,
  isValidPassword,
  normalizeEmail,
  normalizeLoginIdentifier,
  passwordsMatch,
} from "@/lib/auth/form-validation";
import { consumeAuthReturnPath } from "@/lib/auth/return-path";

import { AccountRecoveryModal } from "./account-recovery-modal";
import { TermsModal } from "./terms-modal";
import { VerificationModal, type VerificationModalMode } from "./verification-modal";
import styles from "./auth-form.module.css";

type AuthFormMode = "login" | "signup";

type AuthFormProps = {
  mode: AuthFormMode;
};

type FieldErrors = {
  identifier?: string;
  password?: string;
  confirmPassword?: string;
  phone?: string;
  terms?: string;
};

type ModalState = {
  open: boolean;
  mode: VerificationModalMode;
  method: IdentityVerificationMethod;
};

/** 복구 코드 반복 발송을 짧게 제한해 계정 복구 엔드포인트 남용을 줄입니다. */
const RECOVERY_RESEND_COOLDOWN_MS = 60_000;

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

        // email signup confirm
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

  const handleResendInModal = async () => {
    await handleSendCode();
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
          <>
            <ul className={styles.passwordRules} aria-label={copy.authPasswordPolicy}>
              {passwordRules.map((rule) => {
                const ruleLabel =
                  rule.id === "lowercase"
                    ? copy.authPasswordRule_lowercase
                    : rule.id === "uppercase"
                      ? copy.authPasswordRule_uppercase
                      : rule.id === "number"
                        ? copy.authPasswordRule_number
                        : rule.id === "length"
                          ? copy.authPasswordRule_length
                          : rule.id === "special"
                            ? copy.authPasswordRule_special
                            : copy.authPasswordRule_noEdgeSpace;

                return (
                  <li className={rule.met ? styles.ruleMet : undefined} key={rule.id}>
                    <span aria-hidden="true">{rule.met ? "✓" : "○"}</span>
                    {ruleLabel}
                  </li>
                );
              })}
            </ul>

            <label>
              <span>{copy.authConfirmPassword}</span>
              <input
                autoComplete="new-password"
                name="confirmPassword"
                onBlur={() => markTouched("confirmPassword")}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                value={confirmPassword}
              />
              {fieldErrors.confirmPassword ? (
                <em>{fieldErrors.confirmPassword}</em>
              ) : null}
            </label>

            <fieldset className={styles.identityMethods}>
              <legend>{copy.authIdentityMethod}</legend>
              <label className={styles.identityOption}>
                <input
                  checked={identityMethod === "email"}
                  name="identityMethod"
                  onChange={() => setIdentityMethod("email")}
                  type="radio"
                  value="email"
                />
                <span>{copy.authIdentityEmail}</span>
              </label>
              <label className={styles.identityOption}>
                <input
                  checked={identityMethod === "sms"}
                  name="identityMethod"
                  onChange={() => setIdentityMethod("sms")}
                  type="radio"
                  value="sms"
                />
                <span>{copy.authIdentitySms}</span>
              </label>
            </fieldset>

            {identityMethod === "sms" ? (
              <label>
                <span>{copy.authPhone}</span>
                <input
                  autoComplete="tel"
                  inputMode="tel"
                  name="phone"
                  onBlur={() => markTouched("phone")}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="01012345678"
                  type="tel"
                  value={phone}
                />
                {fieldErrors.phone ? <em>{fieldErrors.phone}</em> : null}
              </label>
            ) : null}

            <fieldset className={styles.consents}>
              <legend>{copy.authAgreements}</legend>
              <ConsentRow
                checked={agreeTerms && agreePrivacy && agreeAge && marketingOptIn}
                label={copy.authAgreeAll}
                onChange={(value) => {
                  setAgreeTerms(value);
                  setAgreePrivacy(value);
                  setAgreeAge(value);
                  setMarketingOptIn(value);
                }}
                showTag={false}
              />
              <ConsentRow
                checked={agreeTerms}
                label={copy.authAgreeTerms}
                onChange={setAgreeTerms}
                onView={() => setOpenDocumentId("termsOfService")}
                required
                viewLabel={copy.authViewTerms}
              />
              <ConsentRow
                checked={agreePrivacy}
                label={copy.authAgreePrivacy}
                onChange={setAgreePrivacy}
                onView={() => setOpenDocumentId("privacyPolicy")}
                required
                viewLabel={copy.authViewTerms}
              />
              <ConsentRow
                checked={agreeAge}
                label={copy.authAgreeAge}
                onChange={setAgreeAge}
                onView={() => setOpenDocumentId("ageGate")}
                required
                viewLabel={copy.authViewTerms}
              />
              <ConsentRow
                checked={marketingOptIn}
                label={copy.authMarketingAll}
                onChange={setMarketingOptIn}
                onView={() => setOpenDocumentId("marketing")}
                viewLabel={copy.authViewTerms}
              />
              {fieldErrors.terms ? <em>{fieldErrors.terms}</em> : null}
            </fieldset>
          </>
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

function ConsentRow({
  checked,
  label,
  onChange,
  onView,
  required = false,
  showTag = true,
  viewLabel,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
  onView?: () => void;
  required?: boolean;
  showTag?: boolean;
  viewLabel?: string;
}) {
  return (
    <div className={styles.consentRow}>
      <label>
        <input
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>
          {showTag ? (required ? "[필수] " : "[선택] ") : null}
          {label}
        </span>
      </label>
      {onView && viewLabel ? (
        <button onClick={onView} type="button">
          {viewLabel}
        </button>
      ) : null}
    </div>
  );
}
