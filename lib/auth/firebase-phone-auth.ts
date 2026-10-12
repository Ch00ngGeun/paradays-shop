// 역할: Firebase Authentication 문자(SMS) OTP 발송·확인.

import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  type ConfirmationResult,
} from "firebase/auth";

import { CognitoAuthError } from "@/lib/auth/cognito-client";
import {
  getFirebaseAuth,
  getFirebaseConfiguration,
} from "@/lib/auth/firebase-app";
import { normalizeKoreanPhoneNumber } from "@/lib/auth/cognito-direct-auth";

let recaptchaVerifier: RecaptchaVerifier | null = null;
let confirmationResult: ConfirmationResult | null = null;

/**
 * 공개 Firebase env만으로는 Phone Auth·authorized domain·SMS 발송이 준비됐다고 보지 않습니다.
 * 운영에서 문자 OTP를 켠 뒤에만 `NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED=true`를 설정합니다.
 */
export function isFirebasePhoneAuthEnabled() {
  const flag = process.env.NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED?.trim().toLowerCase();

  return flag === "1" || flag === "true" || flag === "yes";
}

export function isFirebasePhoneAuthAvailable() {
  return isFirebasePhoneAuthEnabled() && getFirebaseConfiguration().available;
}

function readFirebaseErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = "code" in error ? error.code : null;
  return typeof code === "string" ? code : null;
}

function mapFirebaseSmsError(error: unknown): CognitoAuthError {
  const code = readFirebaseErrorCode(error);
  const message =
    error instanceof Error ? error.message : "문자 인증 코드를 보내지 못했습니다.";

  if (
    code === "auth/configuration-not-found" ||
    code === "auth/operation-not-allowed" ||
    /CONFIGURATION_NOT_FOUND/i.test(message) ||
    /BILLING_NOT_ENABLED/i.test(message)
  ) {
    return new CognitoAuthError(
      "AUTH_IDENTITY_UNAVAILABLE",
      "문자 인증 설정이 완료되지 않았습니다. Firebase Authentication·Phone 제공자·Blaze 결제를 확인하세요.",
    );
  }

  if (code === "auth/too-many-requests" || code === "auth/quota-exceeded") {
    return new CognitoAuthError(
      "AUTH_DIRECT_RATE_LIMITED",
      "문자 인증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  if (
    code === "auth/invalid-phone-number" ||
    code === "auth/missing-phone-number"
  ) {
    return new CognitoAuthError(
      "AUTH_DIRECT_INVALID_PARAMETER",
      "휴대폰 번호 형식이 올바르지 않습니다.",
    );
  }

  if (
    code === "auth/captcha-check-failed" ||
    code === "auth/invalid-app-credential" ||
    code === "auth/argument-error"
  ) {
    return new CognitoAuthError(
      "AUTH_IDENTITY_FAILED",
      "문자 인증 보안 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
    );
  }

  return new CognitoAuthError("AUTH_IDENTITY_FAILED", message);
}

function ensureRecaptcha(containerId: string) {
  const auth = getFirebaseAuth();
  const container = document.getElementById(containerId);

  if (!container) {
    throw new CognitoAuthError(
      "AUTH_IDENTITY_FAILED",
      "문자 인증 준비 중입니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // ignore stale widget cleanup errors
    }
    recaptchaVerifier = null;
  }

  container.replaceChildren();

  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: "invisible",
    callback: () => undefined,
    "expired-callback": () => {
      resetFirebaseRecaptcha();
    },
  });

  return recaptchaVerifier;
}

/** 휴대폰으로 SMS 인증 코드 발송. */
export async function sendFirebaseSmsCode({
  phoneNumber,
  recaptchaContainerId = "firebase-recaptcha",
}: Readonly<{
  phoneNumber: string;
  recaptchaContainerId?: string;
}>) {
  if (!isFirebasePhoneAuthAvailable()) {
    throw new CognitoAuthError(
      "AUTH_IDENTITY_UNAVAILABLE",
      "Firebase 문자 인증 설정이 없습니다.",
    );
  }

  const e164 = normalizeKoreanPhoneNumber(phoneNumber);

  if (!e164) {
    throw new CognitoAuthError(
      "AUTH_DIRECT_INVALID_PARAMETER",
      "휴대폰 번호 형식이 올바르지 않습니다.",
    );
  }

  try {
    const verifier = ensureRecaptcha(recaptchaContainerId);
    confirmationResult = await signInWithPhoneNumber(
      getFirebaseAuth(),
      e164,
      verifier,
    );
    return { phoneNumber: e164 };
  } catch (error) {
    recaptchaVerifier?.clear();
    recaptchaVerifier = null;
    confirmationResult = null;
    throw mapFirebaseSmsError(error);
  }
}

/** SMS 코드 확인. 성공 시 Firebase ID 토큰을 반환함. */
export async function confirmFirebaseSmsCode(code: string) {
  if (!confirmationResult) {
    throw new CognitoAuthError(
      "AUTH_IDENTITY_FAILED",
      "먼저 문자 인증 코드를 요청하세요.",
    );
  }

  try {
    const credential = await confirmationResult.confirm(code.trim());
    const idToken = await credential.user.getIdToken();
    const phoneNumber = credential.user.phoneNumber ?? undefined;

    return { idToken, phoneNumber };
  } catch {
    throw new CognitoAuthError(
      "AUTH_DIRECT_CODE_MISMATCH",
      "문자 인증 코드가 올바르지 않습니다.",
    );
  }
}

/** 가입·찾기 플로우 후 Firebase 세션을 비움 (Cognito가 주 세션). */
export async function clearFirebaseAuthSession() {
  confirmationResult = null;

  try {
    await signOut(getFirebaseAuth());
  } catch {
    // ignore
  }
}

export function resetFirebaseRecaptcha() {
  try {
    recaptchaVerifier?.clear();
  } catch {
    // ignore
  }
  recaptchaVerifier = null;
  confirmationResult = null;
}
