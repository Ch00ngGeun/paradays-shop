"use client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import type {
  AdminDashboardActions,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
} from "@/lib/admin-ui/types";
import { type RefObject } from "react";
import {
  localizedOcrInputError,
  localizedOcrRequestError,
  Notice,
  OcrState,
  OperationActivity,
} from "./admin-shared";

export function useAdminOcrRecognition({
  ocrFile,
  setOcrNotice,
  actions,
  setOcrState,
  ocrRequestGenerationRef,
  ocrFileSelectionRef,
  setIsSavingOcr,
  applyOcrJob,
  recordActivity,
  invalidateOcrRequest,
  setOcrRows,
  ocrRows,
  createOcrRow,
}: Readonly<{
  ocrFile: File | null;
  setOcrNotice: React.Dispatch<React.SetStateAction<Notice>>;
  actions: AdminDashboardActions | undefined;
  setOcrState: React.Dispatch<React.SetStateAction<OcrState>>;
  ocrRequestGenerationRef: RefObject<number>;
  ocrFileSelectionRef: RefObject<number>;
  setIsSavingOcr: React.Dispatch<React.SetStateAction<boolean>>;
  applyOcrJob: (job: AdminOcrRecognitionResult) => void;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  invalidateOcrRequest: () => void;
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
  ocrRows: Readonly<{
    id: string;
    sourceText: string;
    confidence?: number;
    box?: import("@/lib/admin-ui/types").AdminOcrBoundingBox;
    productName: string;
    brand: string;
    option: string;
    quantity: string;
  }>[];
  createOcrRow: (sourceText?: string) => AdminOcrReviewRow;
}>) {
  const handleRecognize = async () => {
    if (!ocrFile) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: "먼저 입고 목록 이미지 파일을 선택해 주세요.",
          en: "Choose a stock-in list image file first.",
        },
      });
      return;
    }

    if (!actions?.recognizeInventory) {
      setOcrState("connection-needed");
      setOcrNotice({
        kind: "error",
        message: {
          ko: "OCR API 연결을 기다리고 있습니다. 이미지나 OCR 키를 브라우저에 직접 노출하지 않습니다.",
          en: "Waiting for the OCR API connection. Images and OCR keys are never exposed directly in the browser.",
        },
      });
      return;
    }

    const requestGeneration = ++ocrRequestGenerationRef.current;
    const selectionId = ocrFileSelectionRef.current;
    setIsSavingOcr(false);

    try {
      setOcrState("recognizing");
      setOcrNotice(null);
      const result = await actions.recognizeInventory({ file: ocrFile });

      if (
        requestGeneration !== ocrRequestGenerationRef.current ||
        selectionId !== ocrFileSelectionRef.current
      ) {
        return;
      }

      applyOcrJob(result);
      const hasTableFields = result.analysis?.mode === "table";
      setOcrNotice({
        kind: result.rows.length > 0 && !hasTableFields ? "error" : "success",
        message:
          result.rows.length === 0
            ? {
                ko: "인식된 텍스트가 없습니다. 더 선명한 이미지를 선택하거나 행 추가로 직접 입력해 주세요.",
                en: "No text was recognized. Choose a sharper image or add rows manually.",
              }
            : hasTableFields
              ? {
                  ko:
                    result.rows.length +
                    "개 상품 행을 인식했습니다. 저장 전에 상품명·브랜드·옵션·수량을 반드시 검토해 주세요.",
                  en: `Recognized ${result.rows.length} product rows. Review the product name, brand, option and quantity before saving.`,
                }
              : {
                  ko:
                    "표의 열을 확정하지 못해 미분류 원문 " +
                    result.rows.length +
                    "개를 그대로 표시합니다. 열 지정 또는 직접 입력으로 상품 필드를 확인해 주세요. 분류 사유: " +
                    (result.analysis?.reason ?? "이전 응답에 분류 정보 없음"),
                  en: `Could not determine the table columns, so ${result.rows.length} unclassified source lines are shown as is. Check the product fields with column mapping or manual input. Reason: ${result.analysis?.reason ?? "no classification in the earlier response"}`,
                },
      });
    } catch (error) {
      if (
        requestGeneration !== ocrRequestGenerationRef.current ||
        selectionId !== ocrFileSelectionRef.current
      ) {
        return;
      }
      setOcrState("idle");
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "OCR 인식 결과를 확인하지 못했습니다. 연결과 이미지를 확인해야 합니다.",
          en: "Could not confirm the OCR result. Check the connection and the image.",
        },
      });
      setOcrNotice({
        kind: "error",
        message: localizedOcrInputError(error) ??
          localizedOcrRequestError(error) ?? {
            ko: "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.",
            en: "The OCR request failed. Check the image format and the admin API and PaddleOCR connections.",
          },
      });
    }
  };

  const updateOcrRow = (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => {
    invalidateOcrRequest();
    setOcrRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  };

  const handleAddOcrRow = () => {
    if (ocrRows.length >= OCR_INPUT_LIMITS.maxReviewRows) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: `검토 행은 최대 ${OCR_INPUT_LIMITS.maxReviewRows}개까지 추가할 수 있습니다.`,
          en: `You can add up to ${OCR_INPUT_LIMITS.maxReviewRows} review rows.`,
        },
      });
      return;
    }

    invalidateOcrRequest();
    setOcrRows((current) => [...current, createOcrRow()]);
  };

  const handleRemoveOcrRow = (id: string) => {
    invalidateOcrRequest();
    setOcrRows((current) => current.filter((row) => row.id !== id));
  };
  return {
    handleRecognize,
    updateOcrRow,
    handleAddOcrRow,
    handleRemoveOcrRow,
  } as const;
}
