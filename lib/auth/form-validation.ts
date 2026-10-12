// 역할: 가입·로그인 폼의 클라이언트 유효성 규칙을 Cognito Hosted UI와 충돌 없이 검사함.

/** Cognito User Pool passwordPolicy.minLength와 동일 */
export const PASSWORD_MIN_LENGTH = 12;

/** 로그인 시 @ 없이 아이디만 넣으면 붙이는 기본 도메인 */
export const DEFAULT_LOGIN_EMAIL_DOMAIN = "gmail.com";

/** 이메일 형식 (앞뒤 공백 trim 후 검사) */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 로그인 아이디 로컬파트 (이메일 @ 앞) */
const LOGIN_ID_PATTERN = /^[^\s@]+$/;

export type PasswordRuleId =
  | "lowercase"
  | "uppercase"
  | "number"
  | "length"
  | "special"
  | "noEdgeSpace";

export type PasswordRuleState = Readonly<{
  id: PasswordRuleId;
  met: boolean;
}>;

/** 입력값을 trim·소문자화한 이메일 정규화 (중복 검사·저장 기준) */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized.length > 0 && EMAIL_PATTERN.test(normalized);
}

/**
 * 로그인용 식별자 정규화.
 * `user` → `user@gmail.com`, 이미 이메일이면 그대로 정규화.
 */
export function normalizeLoginIdentifier(value: string): string {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("@")) {
    return normalizeEmail(trimmed);
  }

  return `${trimmed}@${DEFAULT_LOGIN_EMAIL_DOMAIN}`;
}

/** 로그인 아이디: 로컬파트만 있거나 전체 이메일 */
export function isValidLoginIdentifier(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("@")) {
    return isValidEmail(trimmed);
  }

  return LOGIN_ID_PATTERN.test(trimmed);
}

/** 비밀번호 정책 충족 여부 목록 (실시간 체크 UI용, Cognito Hosted UI와 동일 조건) */
export function getPasswordRuleStates(password: string): PasswordRuleState[] {
  return [
    { id: "lowercase", met: /[a-z]/.test(password) },
    { id: "uppercase", met: /[A-Z]/.test(password) },
    { id: "number", met: /\d/.test(password) },
    { id: "length", met: password.length >= PASSWORD_MIN_LENGTH },
    { id: "special", met: /[^A-Za-z0-9]/.test(password) },
    {
      id: "noEdgeSpace",
      met: password.length > 0 && password === password.trim(),
    },
  ];
}

export function isValidPassword(password: string): boolean {
  return getPasswordRuleStates(password).every((rule) => rule.met);
}

export function passwordsMatch(password: string, confirm: string): boolean {
  return password.length > 0 && password === confirm;
}
