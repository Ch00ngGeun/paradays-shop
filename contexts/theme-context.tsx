// 역할: 라이트/다크 테마 상태와 브라우저 지속성을 제공합니다.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** localStorage에 테마를 저장할 때 쓰는 키 */
const THEME_STORAGE_KEY = "paradays-theme";

export type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 테마 Provider.
 * 서버 첫 렌더는 light로 맞추고, 하이드레이션 후 저장된 설정을 읽습니다.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    window.queueMicrotask(() => {
      try {
        const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

        if (isCurrent && (savedTheme === "light" || savedTheme === "dark")) {
          setTheme(savedTheme);
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

  useEffect(() => {
    if (hasLoadedPreference) {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // 지속성을 사용할 수 없어도 메모리 안의 테마는 계속 쓸 수 있게 합니다.
      }
    }
  }, [hasLoadedPreference, theme]);

  // <html data-theme>을 현재 테마와 동기화합니다.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** ThemeProvider 하위에서 테마 상태에 접근합니다. */
export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}
