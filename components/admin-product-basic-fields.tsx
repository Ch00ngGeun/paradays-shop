"use client";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import { type RefObject } from "react";
import styles from "./admin-dashboard.module.css";
import { GrowingLineInput } from "./admin-product-name-input";

export function AdminProductBasicFields({
  lockInputs,
  isKorean,
  onTextChange,
  applyProductName,
  setNameLineNotice,
  attachNameInput,
  draft,
  nameLineNotice,
  editorId,
  brandInputRef,
  setManualBrandEditor,
  brandChoices,
  manualBrandEditor,
  selectedBrandIndex,
}: Readonly<{
  lockInputs: boolean;
  isKorean: boolean;
  onTextChange: (
    field: Exclude<
      keyof AdminProductDraft,
      | "isVisible"
      | "isFeatured"
      | "nameI18n"
      | "descriptionI18n"
      | "sourceLocale"
      | "productId"
      | "version"
    >,
    value: string,
  ) => void;
  applyProductName: (input: HTMLTextAreaElement) => void;
  setNameLineNotice: React.Dispatch<React.SetStateAction<"blocked" | "merged" | null>>;
  attachNameInput: (input: HTMLTextAreaElement | null) => void;
  draft: Readonly<{
    name: string;
    brand: string;
    category: string;
    sku: string;
    price: string;
    compareAtPrice: string;
    stock: string;
    imageUrl: string;
    sizes: string;
    description: string;
    isVisible: boolean;
    isFeatured: boolean;
    productId?: string;
    version?: number;
    sourceLocale?: "en" | "ko";
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
  }>;
  nameLineNotice: "blocked" | "merged" | null;
  editorId: string;
  brandInputRef: RefObject<HTMLTextAreaElement | null>;
  setManualBrandEditor: React.Dispatch<React.SetStateAction<string | null>>;
  brandChoices: readonly string[];
  manualBrandEditor: string | null;
  selectedBrandIndex: number;
}>) {
  return (
    <fieldset
      className={`${styles.formGroup} ${styles.productFormGrid}`}
      disabled={lockInputs}
    >
      <legend>{isKorean ? "기본 정보" : "Basics"}</legend>
      <label>
        <span>
          {isKorean ? "상품명" : "Product name"} <em>*</em>
        </span>
        <textarea
          className={styles.productNameInput}
          data-admin-guide="products.name"
          onChange={(event) => {
            // While an IME is composing, the text is kept as typed and tidied when it ends.
            if ((event.nativeEvent as InputEvent).isComposing) {
              onTextChange("name", event.target.value);
              return;
            }
            applyProductName(event.target);
          }}
          onCompositionEnd={(event) => applyProductName(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            const input = event.currentTarget;
            const next = `${input.value.slice(0, input.selectionStart)}\n${input.value.slice(input.selectionEnd)}`;
            // A third line, even an empty one, is never started, so nothing after the caret is lost.
            const lines = next
              .replace(/\r\n?/g, "\n")
              .replace(/\n{2,}/g, "\n")
              .split("\n");
            if (lines.length > 2) {
              event.preventDefault();
              setNameLineNotice("blocked");
            }
          }}
          placeholder={
            isKorean ? "예: O'Dwyer Deck [8.25”]" : "e.g. O'Dwyer Deck [8.25”]"
          }
          ref={attachNameInput}
          required
          rows={1}
          value={draft.name}
        />
        {nameLineNotice ? (
          <small role="status">
            {nameLineNotice === "blocked"
              ? isKorean
                ? "상품명은 최대 2줄까지 입력할 수 있습니다."
                : "A product name can have up to 2 lines."
              : isKorean
                ? "상품명은 최대 2줄이라 3번째 줄부터는 2번째 줄 뒤에 이어 붙였습니다."
                : "A product name can have up to 2 lines, so lines from the third were joined to the second."}
          </small>
        ) : null}
      </label>
      <div className={styles.productBrandField}>
        <label htmlFor={`product-brand-${editorId}`}>
          <span>
            {isKorean ? "브랜드" : "Brand"} <em>*</em>
          </span>
        </label>
        <div className={styles.productBrandControls}>
          <GrowingLineInput
            id={`product-brand-${editorId}`}
            inputRef={brandInputRef}
            maxLength={100}
            onValueChange={(value) => onTextChange("brand", value)}
            placeholder={isKorean ? "직접 입력" : "Enter manually"}
            required
            value={draft.brand}
          />
          <select
            aria-label={isKorean ? "브랜드 선택" : "Choose brand"}
            onChange={(event) => {
              if (event.target.value === "manual") {
                setManualBrandEditor(editorId);
                brandInputRef.current?.focus();
              } else if (event.target.value !== "") {
                setManualBrandEditor(null);
                const brand = brandChoices[Number(event.target.value)];
                if (brand) onTextChange("brand", brand);
              }
            }}
            value={
              manualBrandEditor === editorId
                ? "manual"
                : selectedBrandIndex >= 0
                  ? String(selectedBrandIndex)
                  : draft.brand.trim()
                    ? "manual"
                    : ""
            }
          >
            <option value="">{isKorean ? "선택" : "Choose"}</option>
            {brandChoices.map((brand, index) => (
              <option key={brand} value={index}>
                {brand}
              </option>
            ))}
            <option value="manual">{isKorean ? "기타" : "Other"}</option>
          </select>
        </div>
      </div>
      <label>
        <span>{isKorean ? "카테고리" : "Category"}</span>
        <select
          onChange={(event) => onTextChange("category", event.target.value)}
          value={draft.category}
        >
          <option value="Deck">{isKorean ? "데크" : "Deck"}</option>
          <option value="Complete">{isKorean ? "컴플리트" : "Complete"}</option>
          <option value="Trucks">{isKorean ? "트럭" : "Trucks"}</option>
          <option value="Wheels">{isKorean ? "휠" : "Wheels"}</option>
          <option value="Bearings">{isKorean ? "베어링" : "Bearings"}</option>
          <option value="Top">{isKorean ? "상의" : "Tops"}</option>
          <option value="Bottom">{isKorean ? "하의" : "Bottoms"}</option>
          <option value="Accessories">{isKorean ? "액세서리" : "Accessories"}</option>
        </select>
      </label>
    </fieldset>
  );
}
