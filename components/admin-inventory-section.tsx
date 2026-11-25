// 역할: 관리자 재고 메뉴 화면. 상품 재고 목록을 검색·카테고리·브랜드·재고 상태로 거르고, 고른 상품의 재고 조정 패널(StockStepper)을 붙입니다.
"use client";
import adminSharedStyles from "./admin-shared.module.css";
import adminProductSectionStyles from "./admin-product-section.module.css";
import adminInventorySectionStyles from "./admin-inventory-section.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminProductImage } from "./admin-product-image";
import { normalizeSearchText } from "./admin-product-name-input";
import { Notice, NoticeMessage } from "./admin-shared";
import { StockStatusBadge } from "./admin-status";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import { StockStepper } from "./admin-stock-stepper";

export function InventorySection({
  canUpdateStock,
  loadFailed,
  loading,
  notice,
  onChangeStock,
  onRefresh,
  products,
  savingIds,
}: Readonly<{
  canUpdateStock: boolean;
  loadFailed: boolean;
  loading: boolean;
  notice: Notice;
  onChangeStock: (
    productId: string,
    stock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem | null>;
  onRefresh: () => Promise<readonly AdminCatalogListItem[] | null>;
  products: readonly AdminCatalogListItem[];
  savingIds: ReadonlySet<string>;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [filterQuery, setFilterQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "low" | "soldOut">(
    "all",
  );
  const categoryChoices = useMemo(() => {
    const labels = new Map(
      isKorean
        ? [
            ["Deck", "데크"],
            ["Complete", "컴플리트"],
            ["Trucks", "트럭"],
            ["Wheels", "휠"],
            ["Bearings", "베어링"],
            ["Top", "상의"],
            ["Bottom", "하의"],
            ["Outerwear", "아우터"],
            ["Shoes", "신발"],
            ["Accessories", "액세서리"],
            ["Hardware", "하드웨어"],
            ["Protection", "보호장비"],
            ["Other", "기타"],
          ]
        : [
            ["Deck", "Deck"],
            ["Complete", "Complete"],
            ["Trucks", "Trucks"],
            ["Wheels", "Wheels"],
            ["Bearings", "Bearings"],
            ["Top", "Tops"],
            ["Bottom", "Bottoms"],
            ["Outerwear", "Outerwear"],
            ["Shoes", "Shoes"],
            ["Accessories", "Accessories"],
            ["Hardware", "Hardware"],
            ["Protection", "Protection"],
            ["Other", "Other"],
          ],
    );
    for (const category of [
      ...products.map((product) => product.category),
      categoryFilter,
    ]) {
      if (category.trim() && !labels.has(category)) {
        labels.set(category, category);
      }
    }
    return [...labels.entries()];
  }, [categoryFilter, isKorean, products]);
  const brandChoices = useMemo(
    () =>
      [...new Set([...products.map((product) => product.brand), brandFilter])]
        .filter((brand) => brand.trim())
        .sort((left, right) => left.localeCompare(right, "ko")),
    [brandFilter, products],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inventoryFocusFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (inventoryFocusFrameRef.current !== null)
        window.cancelAnimationFrame(inventoryFocusFrameRef.current);
    },
    [],
  );
  const selectedProduct = products.find((product) => product.id === selectedId);
  const selectInventoryProduct = (id: string) => {
    setSelectedId(id);
    if (inventoryFocusFrameRef.current !== null)
      window.cancelAnimationFrame(inventoryFocusFrameRef.current);
    if (window.matchMedia("(max-width: 1200px)").matches) {
      inventoryFocusFrameRef.current = window.requestAnimationFrame(() => {
        inventoryFocusFrameRef.current = null;
        const heading = document.getElementById("inventory-adjustment-title");
        if (heading?.dataset.productId !== id) return;
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    }
  };

  const filteredProducts = useMemo(() => {
    const query = normalizeSearchText(filterQuery);

    return products
      .filter((product) => {
        if (categoryFilter && product.category !== categoryFilter) {
          return false;
        }

        if (brandFilter && product.brand !== brandFilter) {
          return false;
        }

        if (query) {
          const haystack = normalizeSearchText(
            `${product.name} ${product.brand} ${product.sku ?? ""} ${product.category}`,
          );
          if (!haystack.includes(query)) {
            return false;
          }
        }

        if (stockFilter === "inStock" && product.stock <= 0) {
          return false;
        }

        if (stockFilter === "soldOut" && product.stock > 0) {
          return false;
        }

        if (stockFilter === "low" && (product.stock <= 0 || product.stock > 5)) {
          return false;
        }

        return true;
      })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }, [brandFilter, categoryFilter, filterQuery, products, stockFilter]);

  const stockSaving = Boolean(selectedProduct && savingIds.has(selectedProduct.id));
  const stockSaved =
    Boolean(selectedProduct) && notice?.kind === "success" && !stockSaving;
  const inventorySteps: AdminStep[] = [
    {
      label: isKorean ? "상품 선택" : "Select product",
      state: selectedProduct ? "complete" : "current",
    },
    {
      label: isKorean ? "변경 수량 확인" : "Check new quantity",
      state: !selectedProduct
        ? "upcoming"
        : stockSaving || stockSaved
          ? "complete"
          : "current",
    },
    {
      label: isKorean ? "재고 저장" : "Save stock",
      state: !canUpdateStock
        ? "unavailable"
        : stockSaved
          ? "complete"
          : stockSaving
            ? "current"
            : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.inventoryScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label={isKorean ? "재고 작업 흐름" : "Inventory workflow"}
        locale={locale}
        steps={inventorySteps}
      />
      <div className={`${styles.productListHeader} ${adminSharedStyles.wrapRow}`}>
        <div className={adminProductSectionStyles.productPageHeading}>
          <h2>{isKorean ? "재고 관리" : "Inventory"}</h2>
          <p>
            {isKorean
              ? "상품을 선택하고 변경 전후 수량을 확인하세요."
              : "Select a product and check the quantity before and after the change."}
          </p>
        </div>
        <div className={adminProductSectionStyles.productListHeaderActions}>
          <AdminGuideButton
            locale={locale}
            steps={adminGuideSteps("inventory", locale)}
          />
        </div>
      </div>

      <div className={styles.inventoryToolbar}>
        <label className={styles.inventorySearch}>
          <span className="srOnly">{isKorean ? "상품 검색" : "Search products"}</span>
          <input
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={
              isKorean ? "상품명·브랜드·SKU 검색" : "Search name · brand · SKU"
            }
            type="search"
            value={filterQuery}
          />
        </label>
        <label className={styles.inventoryFilter}>
          <span>{isKorean ? "카테고리" : "Category"}</span>
          <select
            onChange={(event) => setCategoryFilter(event.target.value)}
            value={categoryFilter}
          >
            <option value="">{isKorean ? "전체 카테고리" : "All categories"}</option>
            {categoryChoices.map(([category, label]) => (
              <option key={category} value={category}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inventoryFilter}>
          <span>{isKorean ? "브랜드" : "Brand"}</span>
          <select
            onChange={(event) => setBrandFilter(event.target.value)}
            value={brandFilter}
          >
            <option value="">{isKorean ? "전체 브랜드" : "All brands"}</option>
            {brandChoices.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inventoryFilter}>
          <span>{isKorean ? "재고" : "Stock"}</span>
          <select
            onChange={(event) =>
              setStockFilter(
                event.target.value as "all" | "inStock" | "low" | "soldOut",
              )
            }
            value={stockFilter}
          >
            <option value="all">{isKorean ? "전체" : "All"}</option>
            <option value="inStock">{isKorean ? "재고 있음" : "In stock"}</option>
            <option value="low">
              {isKorean ? "재고 주의(1~5)" : "Low stock (1–5)"}
            </option>
            <option value="soldOut">{isKorean ? "품절" : "Sold out"}</option>
          </select>
        </label>
        <button
          className={styles.secondaryButton}
          disabled={loading}
          onClick={() => void onRefresh()}
          type="button"
        >
          {isKorean ? "새로고침" : "Refresh"}
        </button>
      </div>

      {notice ? <NoticeMessage notice={notice} /> : null}
      {loadFailed && !notice ? (
        <p className={styles.noticeError} role="alert">
          {isKorean
            ? "재고 목록을 불러오지 못했습니다. 새로고침으로 다시 확인해 주세요."
            : "Could not load the stock list. Refresh to check again."}
        </p>
      ) : null}

      <div className={adminInventorySectionStyles.inventoryWorkspace}>
        <div className={styles.inventoryPanel} aria-busy={loading}>
          <div className={styles.listPanelHeading}>
            <h2>{isKorean ? "상품 재고 목록" : "Product stock list"}</h2>
            <span>{filteredProducts.length}</span>
          </div>

          {loading && products.length === 0 ? (
            <p className={styles.emptyState}>
              {isKorean ? "재고 목록을 불러오는 중…" : "Loading stock…"}
            </p>
          ) : null}

          {!loading && !loadFailed && filteredProducts.length === 0 ? (
            <div className={styles.emptyState}>
              <strong>
                {isKorean ? "표시할 상품이 없습니다" : "No products to show"}
              </strong>
              <p>
                {isKorean
                  ? "상품 등록에서 상품을 추가하거나 검색 조건을 바꿔 보세요."
                  : "Add products in product registration or change the search."}
              </p>
            </div>
          ) : null}

          {filteredProducts.length > 0 ? (
            <ul
              className={adminInventorySectionStyles.inventoryList}
              data-admin-guide="inventory.list"
            >
              {filteredProducts.map((product) => {
                return (
                  <li className={styles.inventoryRow} key={product.id}>
                    <button
                      aria-label={
                        isKorean
                          ? `${product.name} 재고 조정`
                          : `Adjust stock for ${product.name}`
                      }
                      aria-pressed={selectedId === product.id}
                      className={styles.inventorySelect}
                      onClick={() => selectInventoryProduct(product.id)}
                      type="button"
                    >
                      <AdminProductImage alt="" compact src={product.imageUrl} />
                      <div className={styles.inventoryMeta}>
                        <strong>{product.name}</strong>
                        <span>
                          {product.brand} · {product.category}
                          {product.sku ? ` · ${product.sku}` : ""}
                        </span>
                        <span>
                          {product.sizes || (isKorean ? "옵션 없음" : "No options")} ·{" "}
                          {product.version < 1
                            ? isKorean
                              ? "로컬 초안"
                              : "Local draft"
                            : product.isVisible
                              ? isKorean
                                ? "공개"
                                : "Public"
                              : isKorean
                                ? "비공개"
                                : "Private"}
                        </span>
                      </div>
                      <div className={adminInventorySectionStyles.inventoryQuantity}>
                        <strong>
                          {isKorean ? `${product.stock}개` : product.stock}
                        </strong>
                        <StockStatusBadge locale={locale} stock={product.stock} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        {selectedProduct ? (
          <StockStepper
            key={selectedProduct.id}
            canUpdateStock={canUpdateStock}
            disabled={loading || savingIds.has(selectedProduct.id)}
            onCommit={(stock, expected) =>
              onChangeStock(selectedProduct.id, stock, expected)
            }
            onReload={onRefresh}
            product={selectedProduct}
          />
        ) : (
          <aside
            className={styles.inventoryAdjustment}
            aria-label={isKorean ? "재고 조정" : "Adjust stock"}
          >
            <h2>{isKorean ? "재고 조정" : "Adjust stock"}</h2>
            <div className={styles.emptyState}>
              <strong>{isKorean ? "상품을 선택하세요" : "Select a product"}</strong>
              <p>
                {isKorean
                  ? "목록에서 상품을 선택하면 변경 수량을 미리 확인할 수 있습니다."
                  : "Select a product in the list to preview the new quantity."}
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
