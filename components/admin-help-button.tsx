// 역할: 화면의 설명 문구를 기본으로 숨기고, 컨트롤 옆 '?' 버튼을 눌렀을 때만 모달로 보여 줍니다.
"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import type { Locale } from "@/types/store";

import styles from "./admin-help-button.module.css";

/** 버튼·모달 제목·닫기 버튼의 이름입니다. target은 이미 화면 언어로 된 대상 이름입니다. */
export function adminHelpLabels(target: string, locale: Locale) {
  return locale === "ko"
    ? { button: `${target} 도움말`, title: `${target} 도움말`, close: "닫기" }
    : { button: `Help: ${target}`, title: `Help: ${target}`, close: "Close" };
}

/** 열린 도움말 모달(아래→위 순서). Esc는 맨 위 하나만 닫습니다. */
const openHelpDialogs: string[] = [];

type EscapeEvent = Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">;

/**
 * 도움말 모달의 Esc 처리. window 캡처 단계에서 먼저 받아, 맨 위 도움말이면 닫고 전파를 멈춥니다.
 * 그래서 그 아래의 도움말이나 다른 모달(상세사이즈·모의 테스트)의 Esc 처리기는 실행되지 않습니다.
 */
export function handleHelpEscape(
  event: EscapeEvent,
  id: string,
  onClose: () => void,
  stack: readonly string[] = openHelpDialogs,
) {
  if (event.key !== "Escape" || stack.at(-1) !== id) return;
  event.preventDefault();
  event.stopPropagation();
  onClose();
}

type AdminHelpButtonProps = Readonly<{
  /** 도움말이 설명하는 컨트롤 이름. 예: "옵션 추가" */
  target: string;
  locale: Locale;
  /** 도움말 본문(화면 언어로 된 문단). Optional only so createElement can pass it as an argument. */
  children?: ReactNode;
}>;

/** 작은 '?' 버튼. 누르면 도움말 모달을 열고, 닫으면 버튼으로 포커스를 돌려줍니다. */
export function AdminHelpButton({ target, locale, children }: AdminHelpButtonProps) {
  const labels = adminHelpLabels(target, locale);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Runs after the modal layer is gone, so the background is no longer inert when focus returns.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label={labels.button}
        className={styles.button}
        onClick={() => setOpen(true)}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true" className={styles.mark}>
          ?
        </span>
      </button>
      {open ? (
        <HelpDialog
          closeLabel={labels.close}
          onClose={() => setOpen(false)}
          title={labels.title}
        >
          {children}
        </HelpDialog>
      ) : null}
    </>
  );
}

function HelpDialog({
  title,
  closeLabel,
  onClose,
  children,
}: Readonly<{
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}>) {
  const layer = useModalLayer(true);
  // Esc is handled below, so the trap's own Escape callback does nothing.
  const dialogRef = useFocusTrap(true, () => {});
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    openHelpDialogs.push(titleId);
    const onKeyDown = (event: KeyboardEvent) =>
      handleHelpEscape(event, titleId, () => onCloseRef.current());
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      openHelpDialogs.splice(openHelpDialogs.indexOf(titleId), 1);
    };
  }, [titleId]);
  if (!layer) return null;
  return createPortal(
    <div className={styles.overlay}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        <button className={styles.close} onClick={onClose} type="button">
          {closeLabel}
        </button>
      </section>
    </div>,
    layer,
  );
}
