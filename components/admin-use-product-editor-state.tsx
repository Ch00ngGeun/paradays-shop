"use client";
import { ProductEditorSessions } from "@/lib/admin-ui/navigation";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import { useState, useSyncExternalStore } from "react";
import { emptyProductDraft, Notice } from "./admin-shared";

export function useAdminProductEditorState() {
  const [productEditors] = useState(() => new ProductEditorSessions());
  const productEditor = useSyncExternalStore(
    productEditors.subscribe,
    productEditors.getSnapshot,
    productEditors.getServerSnapshot,
  );
  const productView = productEditor?.mode ?? "list";
  const productDraft = productEditor?.draft ?? emptyProductDraft;
  const [localProducts, setLocalProducts] = useState<readonly AdminCatalogListItem[]>(
    [],
  );
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [isDeletingProducts, setIsDeletingProducts] = useState(false);
  const [productNotice, setProductNotice] = useState<Notice>(null);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [savingProductEditorId, setSavingProductEditorId] = useState<string | null>(
    null,
  );
  return {
    productEditors,
    productEditor,
    productView,
    productDraft,
    localProducts,
    setLocalProducts,
    isLoadingProducts,
    setIsLoadingProducts,
    catalogLoadFailed,
    setCatalogLoadFailed,
    isDeletingProducts,
    setIsDeletingProducts,
    productNotice,
    setProductNotice,
    isSavingProduct,
    setIsSavingProduct,
    savingProductEditorId,
    setSavingProductEditorId,
  } as const;
}
