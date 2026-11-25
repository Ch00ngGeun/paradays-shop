// 역할: 입고 OCR 입력 훅. 원본 이미지 선택·검증, OCR 작업 결과를 검토 행에 반영, 검토 초기화와 이전 요청 무효화, 새 검토 행 생성을 담당합니다.
"use client";
import { validateOcrImageFile } from "@/lib/admin-ui/ocr-input-validation";
import type {
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  OcrMapping,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import { type ChangeEvent, type RefObject } from "react";
import {
  localizedOcrInputError,
  Notice,
  OcrState,
  OperationActivity,
} from "./admin-shared";

export function useAdminOcrInput({
  setOcrInventoryJob,
  ocrCurrentJobRef,
  setOcrJobId,
  setOcrVersion,
  setOcrRawText,
  setOcrRows,
  setOcrAnalysis,
  setOcrState,
  ocrRequestGenerationRef,
  setIsSavingOcr,
  recordActivity,
  ocrFileSelectionRef,
  setOcrFile,
  setOcrNotice,
}: Readonly<{
  setOcrInventoryJob: React.Dispatch<
    React.SetStateAction<Readonly<{
      jobId: string;
      version: number;
      rawText: string;
      rows: readonly AdminOcrReviewRow[];
      analysis?: OcrTableAnalysis;
    }> | null>
  >;
  ocrCurrentJobRef: RefObject<{ jobId: string; version: number } | null>;
  setOcrJobId: React.Dispatch<React.SetStateAction<string | null>>;
  setOcrVersion: React.Dispatch<React.SetStateAction<number | null>>;
  setOcrRawText: React.Dispatch<React.SetStateAction<string>>;
  setOcrRows: React.Dispatch<
    React.SetStateAction<
      Readonly<{
        id: string;
        sourceText: string;
        confidence?: number;
        box?: import("@/lib/admin-ui/types").AdminOcrBoundingBox;
        productName: string;
        brand: string;
        option: string;
        quantity: string;
      }>[]
    >
  >;
  setOcrAnalysis: React.Dispatch<
    React.SetStateAction<
      | Readonly<{
          mode: "table" | "empty" | "unclassified";
          reason?: string;
          table?: import("@/infra/lambda/ocr-table-parser").OcrTableDescriptor;
          mapping?: OcrMapping;
          region?: import("@/infra/lambda/ocr-table-parser").OcrRegionAnalysis;
        }>
      | undefined
    >
  >;
  setOcrState: React.Dispatch<React.SetStateAction<OcrState>>;
  ocrRequestGenerationRef: RefObject<number>;
  setIsSavingOcr: React.Dispatch<React.SetStateAction<boolean>>;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  ocrFileSelectionRef: RefObject<number>;
  setOcrFile: React.Dispatch<React.SetStateAction<File | null>>;
  setOcrNotice: React.Dispatch<React.SetStateAction<Notice>>;
}>) {
  const applyOcrJob = (job: AdminOcrRecognitionResult) => {
    setOcrInventoryJob(null);
    ocrCurrentJobRef.current = { jobId: job.jobId, version: job.version };
    setOcrJobId(job.jobId);
    setOcrVersion(job.version);
    setOcrRawText(job.rawText);
    setOcrRows([...job.rows]);
    setOcrAnalysis(job.analysis);
    setOcrState("review");
  };

  const resetOcrReview = () => {
    setOcrInventoryJob(null);
    ocrRequestGenerationRef.current += 1;
    ocrCurrentJobRef.current = null;
    setIsSavingOcr(false);
    setOcrState("idle");
    setOcrJobId(null);
    setOcrVersion(null);
    setOcrRows([]);
    setOcrRawText("");
    setOcrAnalysis(undefined);
  };

  const invalidateOcrRequest = () => {
    setOcrInventoryJob(null);
    recordActivity({
      key: "ocr",
      section: "ocr",
      status: "working",
      detail: {
        ko: "입고 검토 내용을 수정했습니다. 초안 저장·재고 반영은 별도 확인이 필요합니다.",
        en: "Edited the stock-in review. Saving the draft and applying stock need separate confirmation.",
      },
    });
    // 초안 수정·파일/작업 변경은 PATCH 충돌 뒤 다시 읽는 GET까지 포함한 이전 응답을 모두 무효로 만듭니다.
    // 이전 요청의 finally가 새 저장 상태를 지우지 않게 합니다.
    ocrRequestGenerationRef.current += 1;
    setIsSavingOcr(false);
    setOcrState((current) =>
      current === "recognizing"
        ? ocrCurrentJobRef.current
          ? "review"
          : "idle"
        : current,
    );
  };

  const handleOcrFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    const selectionId = ++ocrFileSelectionRef.current;

    setOcrFile(null);
    resetOcrReview();
    setOcrNotice(null);

    if (!file) {
      return;
    }

    try {
      await validateOcrImageFile(file);

      if (selectionId !== ocrFileSelectionRef.current) {
        return;
      }

      setOcrFile(file);
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "working",
        detail: {
          ko: "입고 이미지를 선택했습니다. 인식·검토·재고 반영은 아직 완료되지 않았습니다.",
          en: "Selected the stock-in image. Recognition, review and stock update are not done yet.",
        },
      });
      setOcrNotice({
        kind: "success",
        message: {
          ko: `“${file.name}” 파일의 이름·MIME·매직 바이트·4MiB 직접 전송 한도를 확인했습니다.`,
          en: `Checked the name, MIME type, magic bytes and 4MiB direct upload limit of “${file.name}”.`,
        },
      });
    } catch (error) {
      if (selectionId !== ocrFileSelectionRef.current) {
        return;
      }

      event.target.value = "";
      setOcrNotice({
        kind: "error",
        message: localizedOcrInputError(error) ?? {
          ko: "이미지 파일을 검증하지 못했습니다. 파일을 다시 선택해 주세요.",
          en: "Could not validate the image file. Choose the file again.",
        },
      });
    }
  };

  const createOcrRow = (sourceText = ""): AdminOcrReviewRow => ({
    id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceText,
    productName: "",
    brand: "",
    option: "",
    quantity: "",
  });
  return {
    applyOcrJob,
    invalidateOcrRequest,
    handleOcrFileChange,
    createOcrRow,
  } as const;
}
