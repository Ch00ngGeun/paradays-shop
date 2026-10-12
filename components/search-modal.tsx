// 역할: 페이지 이동 없이 검색 입력창만 여는 간결한 인플레이스 다이얼로그를 제공합니다.
"use client";

import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type TransitionEvent,
} from "react";

import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";

import styles from "./search-modal.module.css";

type SearchModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** CSS 페이드 시간과 맞춰 transition 이벤트가 누락돼도 모달을 정리할 시간입니다. */
const CLOSE_FALLBACK_DELAY_MS = 360;

/**
 * 검색 오버레이.
 * 흰 화면이 --ui-fade-duration으로 스르륵 나타나고,
 * 밑줄 입력 + 돋보기 아이콘만 둡니다 (Escape·배경 클릭으로 닫기).
 */
export function SearchModal({ isOpen, onClose }: SearchModalProps) {
  const { copy } = useLocale();
  const [query, setQuery] = useState("");
  // 닫힐 때도 페이드아웃이 끝나기 전까지 DOM에 남겨 둡니다.
  const [isMounted, setIsMounted] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(false);

  /** 닫을 때 입력값을 비워 다음 열기에 빈 검색창만 보이게 합니다. */
  const handleClose = () => {
    setQuery("");
    onClose();
  };
  // 닫기 페이드아웃 중에는 트랩을 즉시 해제하고, DOM이 실제로 마운트된 뒤에만 키보드 리스너를 연결합니다.
  const dialogRef = useFocusTrap(isOpen && isMounted, handleClose);

  useEffect(() => {
    let outerFrame = 0;
    let innerFrame = 0;
    let closeFallbackTimeout: number | undefined;

    if (isOpen) {
      // opacity 0 DOM을 먼저 렌더한 뒤 visible로 바꿔 페이드인이 적용되게 합니다.
      outerFrame = window.requestAnimationFrame(() => {
        setIsMounted(true);
        innerFrame = window.requestAnimationFrame(() => setIsVisible(true));
      });
    } else {
      // 닫기 state도 frame 경계에서 갱신해 effect의 동기 state 갱신을 만들지 않습니다.
      outerFrame = window.requestAnimationFrame(() => setIsVisible(false));
      // 브라우저가 transitionend를 보내지 않는 환경에서도 닫힌 모달이 남지 않게 보장합니다.
      if (isMounted) {
        closeFallbackTimeout = window.setTimeout(
          () => setIsMounted(false),
          CLOSE_FALLBACK_DELAY_MS,
        );
      }
    }

    return () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
      if (closeFallbackTimeout !== undefined) {
        window.clearTimeout(closeFallbackTimeout);
      }
    };
  }, [isMounted, isOpen]);

  /** 페이드아웃 transition이 끝난 뒤에만 언마운트합니다. */
  const handleOverlayTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") {
      return;
    }

    if (!isOpen) {
      setIsMounted(false);
    }
  };

  if (!isMounted) {
    return null;
  }

  /** 스크림(배경)만 눌렀을 때 닫고, 다이얼로그 내부 클릭은 유지합니다. */
  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      handleClose();
    }
  };

  /** 입력창에 포커스가 있어도 Escape로 즉시 닫히게 합니다. */
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  };

  return (
    <div
      aria-hidden={!isOpen}
      className={
        isVisible ? `${styles.overlay} ${styles.overlayVisible}` : styles.overlay
      }
      onClick={handleOverlayClick}
      onTransitionEnd={handleOverlayTransitionEnd}
    >
      <section
        aria-labelledby="search-modal-title"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {/* submit은 막고 프로토타입에서는 입력 UI만 제공합니다. */}
        <form onSubmit={(event) => event.preventDefault()}>
          <label className="srOnly" htmlFor="catalog-search">
            {copy.searchTitle}
          </label>
          <input
            data-autofocus
            id="catalog-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.searchPlaceholder}
            type="search"
            value={query}
          />
          <span aria-hidden="true" className={styles.searchIcon}>
            <svg fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <circle
                cx="10.5"
                cy="10.5"
                r="6.25"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M15.2 15.2 20 20"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.4"
              />
            </svg>
          </span>
        </form>
        <h2 className="srOnly" id="search-modal-title">
          {copy.searchTitle}
        </h2>
      </section>
    </div>
  );
}
