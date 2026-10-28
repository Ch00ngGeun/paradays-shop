import type { Locale } from "@/types/store";

import styles from "./admin-stepper.module.css";

/**
 * complete: 실제 결과가 확인된 단계, current: 지금 할 단계, upcoming: 아직 시작 전,
 * unavailable: 기능이 연결되지 않아 완료할 수 없는 단계입니다. 연결 전 단계를 완료로 표시하지 않습니다.
 */
export type AdminStepState = "complete" | "current" | "upcoming" | "unavailable";

export type AdminStep = Readonly<{
  label: string;
  state: AdminStepState;
}>;

export interface AdminStepperProps {
  /** 목록 이름입니다. 예: "상품 등록 작업 흐름" */
  label: string;
  steps: readonly AdminStep[];
  className?: string;
  locale?: Locale;
}

const stateNames: Record<Locale, Record<AdminStepState, string>> = {
  ko: {
    complete: "완료",
    current: "현재 단계",
    upcoming: "예정",
    unavailable: "연결 필요",
  },
  en: {
    complete: "done",
    current: "current step",
    upcoming: "upcoming",
    unavailable: "Needs connection",
  },
};

/** 앞 단계가 모두 완료면 첫 미완료 단계를 current로 만듭니다. unavailable은 건너뛰지 않습니다. */
export function deriveSteps(
  labels: readonly string[],
  completedCount: number,
  unavailableFrom = labels.length,
): AdminStep[] {
  const done = Math.max(0, Math.min(Math.trunc(completedCount), labels.length));
  return labels.map((label, index) => ({
    label,
    state:
      index >= unavailableFrom
        ? "unavailable"
        : index < done
          ? "complete"
          : index === done
            ? "current"
            : "upcoming",
  }));
}

export function AdminStepper({
  label,
  steps,
  className,
  locale = "ko",
}: AdminStepperProps) {
  const names = stateNames[locale];
  return (
    <ol
      aria-label={label}
      className={[styles.stepper, className].filter(Boolean).join(" ")}
    >
      {steps.map((step, index) => (
        <li
          aria-current={step.state === "current" ? "step" : undefined}
          className={styles.step}
          data-state={step.state}
          key={`${index}-${step.label}`}
        >
          <span aria-hidden="true" className={styles.marker}>
            {step.state === "complete" ? (
              <svg fill="none" height="14" viewBox="0 0 16 16" width="14">
                <path
                  d="m3.5 8.5 3 3 6-7"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            ) : (
              index + 1
            )}
          </span>
          <span className={styles.label}>
            {step.state === "complete" ? <span>{index + 1} </span> : null}
            {step.label}
            <span>
              {step.state === "unavailable" ? ` · ${names.unavailable}` : null}
            </span>
            <span className={styles.srOnly}> ({names[step.state]})</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
