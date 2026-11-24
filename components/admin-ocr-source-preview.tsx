"use client";
import { useLocale } from "@/contexts/locale-context";
import type { AdminOcrReviewRow } from "@/lib/admin-ui/types";
import { useEffect, useRef } from "react";
import styles from "./admin-dashboard.module.css";

export function OcrSourcePreview({ file }: Readonly<{ file: File }>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const imageRef = useRef<HTMLImageElement>(null);
  const expandedImageRef = useRef<HTMLImageElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = imageRef.current;
    const expandedImage = expandedImageRef.current;
    const dialog = dialogRef.current;
    if (image) image.src = url;
    if (expandedImage) expandedImage.src = url;
    return () => {
      dialog?.close();
      image?.removeAttribute("src");
      expandedImage?.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <figure className={styles.ocrSourceFigure}>
      {/* 로컬 blob을 DOM ref로 교체·폐기하는 미리보기이며 최적화 서버로 전송하지 않습니다. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={isKorean ? "선택한 입고 원본 이미지" : "Selected stock-in source image"}
        ref={imageRef}
      />
      <figcaption>
        {file.name} ·{" "}
        {(file.size / 1024).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}KiB
      </figcaption>
      <button
        className={styles.secondaryButton}
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        {isKorean ? "원본 이미지 확대 보기" : "Enlarge source image"}
      </button>
      <dialog
        aria-labelledby="ocr-image-dialog-title"
        className={styles.ocrImageDialog}
        ref={dialogRef}
      >
        <div>
          <h3 id="ocr-image-dialog-title">
            {isKorean ? "원본 이미지 확대" : "Enlarged source image"}
          </h3>
          <button
            autoFocus
            className={styles.secondaryButton}
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            {isKorean ? "확대 보기 닫기" : "Close enlarged view"}
          </button>
        </div>
        <p>{file.name}</p>
        {/* 동일한 로컬 blob URL을 사용하며 파일 교체·언마운트 시 폐기합니다. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt={isKorean ? "입고 원본 이미지 확대" : "Enlarged stock-in source image"}
          ref={expandedImageRef}
        />
      </dialog>
    </figure>
  );
}

export function formatOcrConfidence(confidence: number | undefined) {
  if (confidence === undefined) {
    return "—";
  }

  return `${(confidence * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
}

export function formatOcrBoundingBox(box: AdminOcrReviewRow["box"]) {
  if (!box || box.length === 0) {
    return "—";
  }

  return box
    .map(([x, y]) => `${formatOcrCoordinate(x)}, ${formatOcrCoordinate(y)}`)
    .join(" → ");
}

export function formatOcrCoordinate(value: number) {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}
