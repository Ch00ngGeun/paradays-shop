// 역할: 약관 전문을 모달로 보여 줌.
"use client";

import { useEffect, useRef, type RefObject } from "react";

import { useLocale } from "@/contexts/locale-context";
import { getLegalDocument, type LegalDocumentId } from "@/data/legal-terms";
import { useFocusTrap } from "@/hooks/use-focus-trap";

import styles from "./terms-modal.module.css";

type TermsModalProps = {
  documentId: LegalDocumentId | null;
  onClose: () => void;
};

export function TermsModal({ documentId, onClose }: TermsModalProps) {
  const { copy, locale } = useLocale();
  const document = documentId ? getLegalDocument(documentId) : null;
  const isOpen = document !== null;
  const dialogRef = useFocusTrap(isOpen, onClose);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      titleRef.current?.focus();
    }
  }, [isOpen]);

  if (!document) {
    return null;
  }

  return (
    <div className={styles.overlay}>
      <button
        aria-label={copy.close}
        className={styles.scrim}
        onClick={onClose}
        type="button"
      />
      <div
        aria-labelledby="legal-term-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef as RefObject<HTMLDivElement | null>}
        role="dialog"
      >
        <header className={styles.header}>
          <h2 id="legal-term-title" ref={titleRef} tabIndex={-1}>
            {document.title[locale]}
          </h2>
          <p className={styles.version}>v{document.version}</p>
          <button onClick={onClose} type="button">
            {copy.close}
          </button>
        </header>
        <div className={styles.body}>
          <p>{document.body[locale]}</p>
        </div>
      </div>
    </div>
  );
}
