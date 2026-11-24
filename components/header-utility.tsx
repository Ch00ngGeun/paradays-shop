"use client";

import type { useLocale } from "@/contexts/locale-context";
import type { useTheme } from "@/contexts/theme-context";
import type { Locale } from "@/types/store";

import styles from "./header-utility.module.css";

export function HeaderUtilitySwitch({
  locale,
  setLocale,
  languageLabels,
  theme,
  toggleTheme,
  copy,
}: Readonly<{
  locale: Locale;
  setLocale: ReturnType<typeof useLocale>["setLocale"];
  languageLabels: { ko: string; en: string };
  theme: ReturnType<typeof useTheme>["theme"];
  toggleTheme: ReturnType<typeof useTheme>["toggleTheme"];
  copy: ReturnType<typeof useLocale>["copy"];
}>) {
  return (
    <div className={styles.utilitySwitch}>
      <div className={styles.languageSwitch} aria-label="Language">
        <button
          aria-pressed={locale === "ko"}
          onClick={() => setLocale("ko")}
          type="button"
        >
          {languageLabels.ko}
        </button>
        <span aria-hidden="true" className={styles.languageSep}>
          /
        </span>
        <button
          aria-pressed={locale === "en"}
          onClick={() => setLocale("en")}
          type="button"
        >
          {languageLabels.en}
        </button>
      </div>
      <div className={styles.themeSlot}>
        <button
          aria-label={theme === "dark" ? copy.themeToLight : copy.themeToDark}
          aria-pressed={theme === "dark"}
          className={
            theme === "dark"
              ? `${styles.themeToggle} ${styles.themeToggleDark}`
              : styles.themeToggle
          }
          onClick={toggleTheme}
          type="button"
        >
          <span aria-hidden="true" className={styles.themeIcon}>
            {theme === "dark" ? (
              <svg fill="none" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.2"
                />
              </svg>
            ) : (
              <svg fill="none" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M10.1 2.35A5.85 5.85 0 1 0 13.65 11.1 6.15 6.15 0 1 1 10.1 2.35Z"
                  stroke="currentColor"
                  strokeLinejoin="round"
                  strokeWidth="1.2"
                />
              </svg>
            )}
          </span>
          <span className={styles.themeLabel}>
            {theme === "dark" ? "light" : "dark"}
          </span>
        </button>
      </div>
    </div>
  );
}
