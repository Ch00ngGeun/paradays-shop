"use client";
import { useLocale } from "@/contexts/locale-context";
import { useState } from "react";
import styles from "./admin-dashboard.module.css";

/** Display-only fallback: never write the example URL into an editor or API draft. */
export function AdminProductImage({
  alt,
  className = "",
  compact = false,
  src,
}: Readonly<{ alt: string; className?: string; compact?: boolean; src?: string }>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const original = src?.trim() ?? "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [failedExampleFor, setFailedExampleFor] = useState<string | null>(null);
  const isExample =
    !original ||
    original === "/images/product-placeholder.svg" ||
    original === "/images/admin-board-example.png" ||
    failedSrc === original;
  const exampleFailed = isExample && failedExampleFor === original;
  return (
    <span
      className={`${styles.adminProductImage} ${className}`}
      data-example={isExample || undefined}
      data-compact={compact || undefined}
    >
      {!exampleFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt={
            isExample
              ? isKorean
                ? "상품 이미지 없음 · 보드 예시 이미지"
                : "No product image · example board image"
              : alt
          }
          onError={() => {
            if (isExample) setFailedExampleFor(original);
            else setFailedSrc(original);
          }}
          src={isExample ? "/images/admin-board-example.png" : original}
        />
      ) : null}
      {isExample ? (
        <span
          className={styles.exampleImageLabel}
          title={isKorean ? "이미지 없음 · 예시 이미지" : "No image · example image"}
        >
          {compact
            ? isKorean
              ? "예시"
              : "Example"
            : isKorean
              ? "이미지 없음 · 예시 이미지"
              : "No image · example image"}
        </span>
      ) : null}
    </span>
  );
}
