// 역할: 일시적인 다이얼로그 안에서 키보드 포커스를 가두고, 닫힐 때 원래 위치로 되돌립니다.
"use client";

import { useEffect, useRef } from "react";

/** 포커스 가능한 컨트롤을 고르는 CSS 셀렉터 */
const focusableSelector = [
  'a[href]:not([tabindex="-1"]):not([aria-hidden="true"])',
  'button:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  'input:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  'select:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])',
  '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(", ");

/**
 * 모달/드로어용 포커스 트랩 훅.
 * isActive가 true일 때 Tab 순환·Escape 닫기를 걸고, 비활성화 시 이전 포커스를 복원합니다.
 * 반환값은 다이얼로그 루트에 붙일 ref입니다.
 */
export function useFocusTrap(isActive: boolean, onEscape: () => void) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // Tab과 Escape가 중첩된 모든 컨트롤에서 동작하도록 키보드 처리는 document 수준에서 실행합니다.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const container = containerRef.current;

    if (!container) {
      return;
    }

    previouslyFocusedElement.current = document.activeElement as HTMLElement | null;
    const firstTarget = container.querySelector<HTMLElement>("[data-autofocus]");
    const fallbackTarget = container.querySelector<HTMLElement>(focusableSelector);
    (firstTarget ?? fallbackTarget)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(
        container.querySelectorAll<HTMLElement>(focusableSelector),
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const isBeforeFirstFocusable =
        activeElement === container ||
        (activeElement instanceof HTMLElement &&
          container.contains(activeElement) &&
          activeElement.tabIndex < 0);

      if (
        event.shiftKey &&
        (activeElement === firstElement || isBeforeFirstFocusable)
      ) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedElement.current?.focus();
    };
  }, [isActive]);

  return containerRef;
}
