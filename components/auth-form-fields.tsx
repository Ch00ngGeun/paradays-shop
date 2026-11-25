// 역할: 회원가입 폼의 추가 입력칸. 비밀번호 규칙 표시·비밀번호 확인, 본인 확인 방식(이메일·SMS)과 휴대폰 번호, 약관·개인정보·연령·마케팅 동의 줄(전문 보기 포함)을 그립니다.
"use client";

import type { Dispatch, SetStateAction } from "react";

import type { useLocale } from "@/contexts/locale-context";
import type { LegalDocumentId } from "@/data/legal-terms";
import type { IdentityVerificationMethod } from "@/lib/auth/cognito-direct-auth";
import type { getPasswordRuleStates } from "@/lib/auth/form-validation";

import type { FieldErrors } from "./auth-form-actions";
import styles from "./auth-form.module.css";

export function AuthSignupFields({
  copy,
  confirmPassword,
  setConfirmPassword,
  phone,
  setPhone,
  identityMethod,
  setIdentityMethod,
  agreeTerms,
  setAgreeTerms,
  agreePrivacy,
  setAgreePrivacy,
  agreeAge,
  setAgreeAge,
  marketingOptIn,
  setMarketingOptIn,
  setOpenDocumentId,
  passwordRules,
  fieldErrors,
  markTouched,
}: Readonly<{
  copy: ReturnType<typeof useLocale>["copy"];
  confirmPassword: string;
  setConfirmPassword: Dispatch<SetStateAction<string>>;
  phone: string;
  setPhone: Dispatch<SetStateAction<string>>;
  identityMethod: IdentityVerificationMethod;
  setIdentityMethod: Dispatch<SetStateAction<IdentityVerificationMethod>>;
  agreeTerms: boolean;
  setAgreeTerms: Dispatch<SetStateAction<boolean>>;
  agreePrivacy: boolean;
  setAgreePrivacy: Dispatch<SetStateAction<boolean>>;
  agreeAge: boolean;
  setAgreeAge: Dispatch<SetStateAction<boolean>>;
  marketingOptIn: boolean;
  setMarketingOptIn: Dispatch<SetStateAction<boolean>>;
  setOpenDocumentId: Dispatch<SetStateAction<LegalDocumentId | null>>;
  passwordRules: ReturnType<typeof getPasswordRuleStates>;
  fieldErrors: FieldErrors;
  markTouched: (field: string) => void;
}>) {
  return (
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
        {fieldErrors.confirmPassword ? <em>{fieldErrors.confirmPassword}</em> : null}
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
