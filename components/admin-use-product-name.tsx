// 역할: 상품명 입력 훅. 상품명을 2줄 이하로 정리하고 줄 제한 알림을 관리하며, 자동 높이와 편집 뒤 커서 위치를 맞춥니다.
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
  // field-sizing을 지원하는 브라우저는 상자가 스스로 늘어나고, 그 밖에서는 내용과 폭에 맞춰 높이를 맞춥니다.
  // 콜백을 고정해 다시 렌더해도 observer를 다시 연결하지 않으므로, 봐야 할 폭 변화를 놓치지 않습니다.
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
    // 값을 다시 쓰면 커서가 끝으로 가므로, 편집하던 위치로 되돌립니다.
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
