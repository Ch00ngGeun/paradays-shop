// 역할: 화면의 설명 문구를 기본으로 숨기고, 컨트롤 옆 '?' 버튼을 눌렀을 때만 모달로 보여 줍니다.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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

type AdminHelpButtonProps = Readonly<{
  /** 도움말이 설명하는 컨트롤 이름. 예: "옵션 추가" */
  target: string;
  locale: Locale;
  /** 도움말 본문(화면 언어로 된 문단). */
  children: ReactNode;
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
  const dialogRef = useFocusTrap(true, onClose);
  if (!layer) return null;
  return createPortal(
    <div className={styles.overlay}>
      <section
        aria-labelledby="admin-help-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={styles.title} id="admin-help-title">
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
