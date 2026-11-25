// 역할: 입고 OCR 메뉴의 원본 파일·인식 상태·원문·검토 행·작업 id/버전·표 분석·입고 반영 상태와 입고 시도 기록 저장소를 묶은 상태 훅입니다.
"use client";
import type {
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import { useMemo, useRef, useState } from "react";
import { Notice, OcrState } from "./admin-shared";
import { OcrInventoryAttemptStore } from "./ocr-inventory-commit";

export function useAdminOcrReviewState() {
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [ocrRawText, setOcrRawText] = useState("");
  const [ocrRows, setOcrRows] = useState<AdminOcrReviewRow[]>([]);
  const [ocrNotice, setOcrNotice] = useState<Notice>(null);
  const [isSavingOcr, setIsSavingOcr] = useState(false);
  const [isApplyingOcrInventory, setIsApplyingOcrInventory] = useState(false);
  const [ocrJobId, setOcrJobId] = useState<string | null>(null);
  const [ocrVersion, setOcrVersion] = useState<number | null>(null);
  const [ocrAnalysis, setOcrAnalysis] = useState<OcrTableAnalysis | undefined>();
  const [ocrInventoryJob, setOcrInventoryJob] =
    useState<AdminOcrRecognitionResult | null>(null);
  const ocrInventoryAttempts = useMemo(() => new OcrInventoryAttemptStore(), []);
  const ocrFileSelectionRef = useRef(0);
  return {
    ocrFile,
    setOcrFile,
    ocrState,
    setOcrState,
    ocrRawText,
    setOcrRawText,
    ocrRows,
    setOcrRows,
    ocrNotice,
    setOcrNotice,
    isSavingOcr,
    setIsSavingOcr,
    isApplyingOcrInventory,
    setIsApplyingOcrInventory,
    ocrJobId,
    setOcrJobId,
    ocrVersion,
    setOcrVersion,
    ocrAnalysis,
    setOcrAnalysis,
    ocrInventoryJob,
    setOcrInventoryJob,
    ocrInventoryAttempts,
    ocrFileSelectionRef,
  } as const;
}
