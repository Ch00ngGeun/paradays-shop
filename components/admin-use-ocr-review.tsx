// 역할: 입고 OCR 검토 훅. 검토본 저장(작업 버전 확인, 늦은 응답 무시)과 영역 지정 결과로 검토 행 재매핑(미리보기·적용)을 서버에 요청합니다.
"use client";
import { getOcrReviewRowValidationMessage } from "@/lib/admin-ui/ocr-input-validation";
import type {
  AdminDashboardActions,
  AdminOcrRecognitionResult,
  AdminOcrRemapResult,
  AdminOcrReviewRow,
  OcrMapping,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import { type RefObject } from "react";
import {
  localizedOcrRequestError,
  Notice,
  OcrState,
  OperationActivity,
} from "./admin-shared";

export function useAdminOcrReview({
  ocrRows,
  setOcrNotice,
  actions,
  ocrJobId,
  ocrVersion,
  setOcrState,
  recordActivity,
  ocrRequestGenerationRef,
  ocrCurrentJobRef,
  setIsSavingOcr,
  ocrRawText,
  applyOcrJob,
  setOcrInventoryJob,
}: Readonly<{
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
  setOcrNotice: React.Dispatch<React.SetStateAction<Notice>>;
  actions: AdminDashboardActions | undefined;
  ocrJobId: string | null;
  ocrVersion: number | null;
  setOcrState: React.Dispatch<React.SetStateAction<OcrState>>;
  recordActivity: (activity: Omit<OperationActivity, "at">) => void;
  ocrRequestGenerationRef: RefObject<number>;
  ocrCurrentJobRef: RefObject<{ jobId: string; version: number } | null>;
  setIsSavingOcr: React.Dispatch<React.SetStateAction<boolean>>;
  ocrRawText: string;
  applyOcrJob: (job: AdminOcrRecognitionResult) => void;
  setOcrInventoryJob: React.Dispatch<
    React.SetStateAction<Readonly<{
      jobId: string;
      version: number;
      rawText: string;
      rows: readonly AdminOcrReviewRow[];
      analysis?: OcrTableAnalysis;
    }> | null>
  >;
}>) {
  const handleOcrSave = async () => {
    if (ocrRows.length === 0) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: "저장할 입고 행이 없습니다.",
          en: "There are no stock-in rows to save.",
        },
      });
      return;
    }

    const validationMessage = getOcrReviewRowValidationMessage(ocrRows);

    if (validationMessage) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: validationMessage,
          en: getOcrReviewRowValidationMessage(ocrRows, "en") ?? validationMessage,
        },
      });
      return;
    }

    if (!actions?.saveOcrReview || !ocrJobId || ocrVersion === null) {
      setOcrState("connection-needed");
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "입고 검토 저장 연결이 필요합니다. 서버 미저장 · 재고 미반영",
          en: "The stock-in review save needs a connection. Not saved to the server · Stock not updated",
        },
      });
      setOcrNotice({
        kind: "error",
        message: {
          ko: "OCR 검토 저장 API가 연결되지 않았습니다. 현재 화면의 초안은 서버에 저장되지 않았습니다.",
          en: "The OCR review save API is not connected. The draft on this screen was not saved to the server.",
        },
      });
      return;
    }

    const requestGeneration = ++ocrRequestGenerationRef.current;
    const jobId = ocrJobId;
    const version = ocrVersion;
    const isCurrentRequest = () =>
      requestGeneration === ocrRequestGenerationRef.current &&
      ocrCurrentJobRef.current?.jobId === jobId &&
      ocrCurrentJobRef.current?.version === version;

    try {
      setIsSavingOcr(true);
      const result = await actions.saveOcrReview({
        jobId: ocrJobId,
        version: ocrVersion,
        rows: ocrRows,
        rawText: ocrRawText,
      });

      if (!isCurrentRequest()) {
        return;
      }

      applyOcrJob(result.job);

      if (result.kind === "conflict") {
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: "attention",
          detail: {
            ko: "검토본이 변경되어 최신 내용을 다시 확인해야 합니다.",
            en: "The review changed. Check the latest content again.",
          },
        });
        setOcrNotice({
          kind: "error",
          message: {
            ko: "다른 관리자의 수정이 먼저 저장되어 최신 OCR 검토본을 다시 불러왔습니다. 내용을 다시 확인한 뒤 저장해 주세요.",
            en: "Another admin saved changes first, so the latest OCR review was reloaded. Check the content again, then save.",
          },
        });
        return;
      }

      setOcrNotice({
        kind: "success",
        message: {
          ko: `검토한 입고 행을 관리자 API에 저장했습니다. 서버 버전 ${result.job.version}을 적용했습니다. 실제 재고를 변경하려면 아래 재고 반영에서 상품과 수량을 확인해 주세요.`,
          en: `Saved the reviewed stock-in rows to the admin API as server version ${result.job.version}. To change actual stock, check the products and quantities in the stock update below.`,
        },
      });
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "draft",
        detail: {
          ko: "입고 검토 초안을 서버에 저장했습니다. 실제 재고 반영은 별도입니다.",
          en: "Saved the stock-in review draft to the server. Updating actual stock is a separate step.",
        },
      });
      setOcrInventoryJob(result.job);
    } catch {
      if (!isCurrentRequest()) {
        return;
      }
      setOcrNotice({
        kind: "error",
        message: {
          ko: "입고 행을 저장하지 못했습니다. 내용을 확인한 뒤 다시 시도해 주세요.",
          en: "Could not save the stock-in rows. Check the content, then try again.",
        },
      });
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "입고 검토 초안의 저장 결과를 확인해야 합니다. 재고 반영 완료가 아닙니다.",
          en: "Check the save result of the stock-in review draft. Stock has not been updated.",
        },
      });
    } finally {
      if (requestGeneration === ocrRequestGenerationRef.current) {
        setIsSavingOcr(false);
      }
    }
  };

  const handleOcrRemap = async (
    mapping: OcrMapping,
    preview: boolean,
  ): Promise<AdminOcrRemapResult | null> => {
    if (!actions?.remapOcrReview || !ocrJobId || ocrVersion === null) return null;
    const generation = ++ocrRequestGenerationRef.current;
    const jobId = ocrJobId,
      version = ocrVersion;
    const current = () =>
      generation === ocrRequestGenerationRef.current &&
      ocrCurrentJobRef.current?.jobId === jobId &&
      ocrCurrentJobRef.current?.version === version;
    try {
      setIsSavingOcr(true);
      const result = await actions.remapOcrReview({ jobId, version, mapping, preview });
      if (!current()) return null;
      if (result.kind !== "preview") {
        applyOcrJob(result.job);
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: result.kind === "conflict" ? "attention" : "working",
          detail:
            result.kind === "conflict"
              ? {
                  ko: "검토본이 변경되어 최신 내용을 다시 확인해야 합니다.",
                  en: "The review changed. Check the latest content again.",
                }
              : {
                  ko: "열 지정이 변경되었습니다. 상품 필드를 다시 검토하고 초안을 저장하세요.",
                  en: "The column mapping changed. Review the product fields again and save the draft.",
                },
        });
        setOcrNotice({
          kind: result.kind === "conflict" ? "error" : "success",
          message:
            result.kind === "conflict"
              ? {
                  ko: "다른 수정이 먼저 저장되어 최신 OCR 검토본을 불러왔습니다. 열 지정을 다시 미리보기해 주세요.",
                  en: "Another change was saved first, so the latest OCR review was loaded. Preview the column mapping again.",
                }
              : {
                  ko: `열 지정을 원본 OCR에 적용했습니다. 서버 버전 ${result.job.version}의 상품 필드를 검토한 뒤 초안을 저장해 주세요.`,
                  en: `Applied the column mapping to the original OCR. Review the product fields of server version ${result.job.version}, then save the draft.`,
                },
        });
      }
      return result;
    } catch (error) {
      if (current()) {
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: "attention",
          detail: {
            ko: "열 지정 결과를 확인하지 못했습니다. 기존 검토본은 유지됩니다.",
            en: "Could not confirm the column mapping result. The existing review is kept.",
          },
        });
        setOcrNotice({
          kind: "error",
          message: localizedOcrRequestError(error) ?? {
            ko: "열 지정에 실패했습니다. 현재 검토본은 유지됩니다.",
            en: "The column mapping failed. The current review is kept.",
          },
        });
      }
      return null;
    } finally {
      if (generation === ocrRequestGenerationRef.current) setIsSavingOcr(false);
    }
  };
  return { handleOcrSave, handleOcrRemap } as const;
}
