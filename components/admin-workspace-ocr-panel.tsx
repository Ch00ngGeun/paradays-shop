"use client";
import { OCR_INPUT_LIMITS } from "@/lib/admin-ui/ocr-input-validation";
import styles from "./admin-dashboard.module.css";
import { OcrSection } from "./admin-ocr-section";
import { AdminWorkspaceContext } from "./admin-workspace-context";
import { OcrInventoryCommitPanel } from "./ocr-inventory-commit";
import { OcrRegionMappingPanel } from "./ocr-region-mapping";

export function AdminWorkspaceOcrPanel({
  context,
}: Readonly<{ context: AdminWorkspaceContext }>) {
  const {
    activeSection,
    ocrRows,
    actions,
    ocrJobId,
    ocrVersion,
    ocrFile,
    isSavingOcr,
    isApplyingOcrInventory,
    ocrInventoryJob,
    ocrNotice,
    handleAddOcrRow,
    handleOcrFileChange,
    handleRecognize,
    handleRemoveOcrRow,
    handleOcrSave,
    updateOcrRow,
    ocrRawText,
    ocrInventoryAttempts,
    setIsApplyingOcrInventory,
    catalogMutationGenerationRef,
    setLocalProducts,
    ocrAnalysis,
    ocrState,
    handleOcrRemap,
  } = context;
  return (
    <>
      {activeSection === "ocr" ? (
        <OcrSection
          canAddRow={ocrRows.length < OCR_INPUT_LIMITS.maxReviewRows}
          canSave={Boolean(
            actions?.saveOcrReview &&
              ocrJobId &&
              ocrVersion !== null &&
              ocrRows.length > 0,
          )}
          file={ocrFile}
          isSaving={isSavingOcr || isApplyingOcrInventory}
          jobVersion={ocrVersion}
          reviewSaved={Boolean(
            ocrInventoryJob &&
              ocrInventoryJob.jobId === ocrJobId &&
              ocrInventoryJob.version === ocrVersion,
          )}
          notice={ocrNotice}
          onAddRow={handleAddOcrRow}
          onFileChange={handleOcrFileChange}
          onRecognize={() => void handleRecognize()}
          onRemoveRow={handleRemoveOcrRow}
          onSave={() => void handleOcrSave()}
          onRowChange={updateOcrRow}
          rows={ocrRows}
          rawText={ocrRawText}
          inventoryPanel={
            ocrInventoryJob ? (
              <OcrInventoryCommitPanel
                key={`${ocrInventoryJob.jobId}:${ocrInventoryJob.version}`}
                job={ocrInventoryJob}
                actions={actions}
                attempts={ocrInventoryAttempts}
                onBusyChange={setIsApplyingOcrInventory}
                onProductUpdated={(product) => {
                  catalogMutationGenerationRef.current += 1;
                  setLocalProducts((current) =>
                    current.some((item) => item.id === product.id)
                      ? current.map((item) =>
                          item.id === product.id && item.version <= product.version
                            ? product
                            : item,
                        )
                      : [...current, product],
                  );
                }}
              />
            ) : undefined
          }
          mappingPanel={
            ocrJobId && ocrVersion !== null ? (
              <div
                key={`${ocrJobId}:${ocrVersion}`}
                className={`${styles.sectionStack} ${styles.ocrSectionStack}`}
              >
                <OcrRegionMappingPanel
                  file={ocrFile}
                  jobId={ocrJobId}
                  version={ocrVersion}
                  analysis={ocrAnalysis}
                  disabled={
                    isSavingOcr ||
                    isApplyingOcrInventory ||
                    ocrState === "recognizing" ||
                    !actions?.remapOcrReview
                  }
                  onRemap={handleOcrRemap}
                />
              </div>
            ) : undefined
          }
          state={ocrState}
        />
      ) : null}
    </>
  );
}
