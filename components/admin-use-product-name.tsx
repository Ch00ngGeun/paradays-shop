"use client";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { fitProductNameInput, limitProductNameLines } from "./admin-product-name-input";

export function useAdminProductName({
  draft,
  onTextChange,
}: Readonly<{
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
}>) {
  const nameInputRef = useRef<HTMLTextAreaElement | null>(null);
  const nameResizeRef = useRef<ResizeObserver | null>(null);
  const nameCaretRef = useRef<number | null>(null);
  const [nameCaretTick, setNameCaretTick] = useState(0);
  const [nameLineNotice, setNameLineNotice] = useState<"blocked" | "merged" | null>(
    null,
  );
  // field-sizing grows the box in supporting browsers; elsewhere the height follows the content and the width.
  // Stable, so a re-render never reconnects the observer and skips a width change it should see.
  const attachNameInput = useCallback((input: HTMLTextAreaElement | null) => {
    nameInputRef.current = input;
    nameResizeRef.current?.disconnect();
    nameResizeRef.current = null;
    if (!input || CSS.supports("field-sizing", "content")) return;
    fitProductNameInput(input);
    let width = input.clientWidth;
    nameResizeRef.current = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitProductNameInput(input);
    });
    nameResizeRef.current.observe(input);
  }, []);

  useLayoutEffect(() => {
    const input = nameInputRef.current;
    if (!input) return;
    if (!CSS.supports("field-sizing", "content")) fitProductNameInput(input);
    // A rewritten value would put the caret at the end, so it goes back to where the edit was.
    const caret = nameCaretRef.current;
    nameCaretRef.current = null;
    if (caret !== null && document.activeElement === input)
      input.setSelectionRange(caret, caret);
  }, [draft.name, nameCaretTick]);
  const applyProductName = (input: HTMLTextAreaElement) => {
    const raw = input.value;
    const limited = limitProductNameLines(raw);
    if (limited.value !== raw) {
      nameCaretRef.current = Math.min(
        limitProductNameLines(raw.slice(0, input.selectionStart)).value.length,
        limited.value.length,
      );
      setNameCaretTick((tick) => tick + 1);
    }
    setNameLineNotice(limited.merged ? "merged" : null);
    onTextChange("name", limited.value);
  };
  return {
    nameLineNotice,
    setNameLineNotice,
    attachNameInput,
    applyProductName,
  } as const;
}
