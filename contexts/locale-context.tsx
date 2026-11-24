// 역할: 활성 인터페이스 언어를 저장하고 새로고침 이후에도 사용자 설정을 유지합니다.
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { Locale } from "@/types/store";

import { productDescriptionTranslations, translations } from "./locale-translations";

/** localStorage에 선택한 언어를 저장할 때 쓰는 키 */
const LOCALE_STORAGE_KEY = "paradays-locale";
/** app/layout.tsx의 head 스크립트가 저장값 ko일 때 걸어 두는 표시 보류 속성(이름을 함께 바꿀 것). */
const LOCALE_PENDING_ATTRIBUTE = "data-locale-pending";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  copy: (typeof translations)[Locale];
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * 언어 Provider.
 * 서버 첫 렌더는 항상 en으로 맞추고, 하이드레이션 후 저장된 선호을 읽습니다.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);

  // 하이드레이션 이후에 로드해 서버 마크업을 결정적으로 유지하고, 스토리지는 브라우저에서만 사용합니다.
  useEffect(() => {
    let isCurrent = true;

    // 동기 effect 업데이트를 피하려고 스토리지 읽기를 외부 브라우저 콜백으로 예약합니다.
    window.queueMicrotask(() => {
      try {
        const savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);

        if (isCurrent && (savedLocale === "ko" || savedLocale === "en")) {
          setLocale(savedLocale);
        }
      } catch {
        // 시크릿/임베디드 브라우징 환경에서는 스토리지를 사용할 수 없을 수 있습니다.
      } finally {
        if (isCurrent) {
          setHasLoadedPreference(true);
        }
      }
    });

    return () => {
      isCurrent = false;
    };
  }, []);

  // 로드가 끝난 뒤에만 선택 언어를 저장합니다.
  useEffect(() => {
    if (hasLoadedPreference) {
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        // 지속성을 사용할 수 없어도 메모리 안의 로케일은 계속 쓸 수 있게 합니다.
      }
    }
  }, [hasLoadedPreference, locale]);

  // 저장 언어가 화면에 반영된 커밋에서 그리기 전에 표시 보류를 해제합니다.
  // dev Strict Mode 재마운트가 html 속성을 지우면 확정 전까지 다시 겁니다.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (hasLoadedPreference) {
      root.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
      return;
    }
    try {
      if (window.localStorage.getItem(LOCALE_STORAGE_KEY) !== "ko") return;
    } catch {
      // 스토리지를 못 읽으면 보류하지 않고 기본 언어로 바로 보여 줍니다.
      return;
    }
    root.setAttribute(LOCALE_PENDING_ATTRIBUTE, "");
    // 저장값 복원이 끝나지 않아도 화면이 숨겨진 채 남지 않게 합니다(head 스크립트와 같은 10초).
    // 이때 보이는 본문은 아직 en이므로 문서 언어도 en으로 맞춥니다.
    const release = () => {
      if (!root.hasAttribute(LOCALE_PENDING_ATTRIBUTE)) return;
      root.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
      root.lang = "en";
    };
    const timer = window.setTimeout(release, 10_000);
    // 복원 전에 해제돼도(재마운트·오류 경계) 숨김이 남지 않게 정리 때 함께 풂.
    // 문서 언어는 아래 lang effect가 현재 locale로 맞춥니다.
    return () => {
      window.clearTimeout(timer);
      root.removeAttribute(LOCALE_PENDING_ATTRIBUTE);
    };
  }, [hasLoadedPreference]);

  // <html lang>을 현재 로케일과 동기화합니다.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale, copy: translations[locale] }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** LocaleProvider 하위에서 언어·UI 문구에 접근합니다. */
export function useLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider.");
  }

  return context;
}

/** 번역표에 없는 새 상품 사양은 원문을 노출해 카탈로그 렌더링을 끊지 않습니다. */
export function translateProductDescription(locale: Locale, description: string) {
  return productDescriptionTranslations[locale][description] ?? description;
}
