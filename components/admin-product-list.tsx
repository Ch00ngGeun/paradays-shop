"use client";
import adminSharedStyles from "./admin-shared.module.css";
import adminProductSectionStyles from "./admin-product-section.module.css";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec, Locale } from "@/types/store";
import { type PointerEvent as ReactPointerEvent } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminProductImage } from "./admin-product-image";
import { moneyFormatter, Notice, NoticeMessage } from "./admin-shared";
import { StockStatusBadge } from "./admin-status";

export function AdminProductList({
  productStepper,
  isKorean,
  locale,
  onOpenCreate,
  notice,
  setFilterQuery,
  filterQuery,
  setStatusFilter,
  statusFilter,
  setStockFilter,
  stockFilter,
  allFilteredSelected,
  toggleSelectAllFiltered,
  deleting,
  selectedProducts,
  onDeleteProducts,
  loading,
  filteredProducts,
  products,
  selectedIds,
  applySelection,
  handleSelectPointerDown,
  handleSelectPointerEnter,
  onEditProduct,
}: Readonly<{
  productStepper: import("@/node_modules/@types/react/jsx-runtime").JSX.Element;
  isKorean: boolean;
  locale: Locale;
  onOpenCreate: () => void;
  notice: Notice;
  setFilterQuery: React.Dispatch<React.SetStateAction<string>>;
  filterQuery: string;
  setStatusFilter: React.Dispatch<React.SetStateAction<"draft" | "all" | "published">>;
  statusFilter: "draft" | "all" | "published";
  setStockFilter: React.Dispatch<React.SetStateAction<"all" | "inStock" | "soldOut">>;
  stockFilter: "all" | "inStock" | "soldOut";
  allFilteredSelected: boolean;
  toggleSelectAllFiltered: () => void;
  deleting: boolean;
  selectedProducts: Readonly<{
    id: string;
    name: string;
    brand: string;
    category: string;
    price: number;
    stock: number;
    isVisible: boolean;
    version: number;
    sku?: string;
    imageUrl?: string;
    compareAtPrice?: number;
    sizes: string;
    description: string;
    isFeatured: boolean;
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
    deckSpec?: DeckSpec;
    deckSpecsBySize?: Readonly<Record<string, DeckSpec>>;
    sizeChart?: Readonly<{ kind: SizeChartKind; values: SizeChartValues }>;
    sizeChartKind?: SizeChartKind;
    sizeChartsBySize?: Readonly<Record<string, SizeChartValues>>;
  }>[];
  onDeleteProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => void;
  loading: boolean;
  filteredProducts: Readonly<{
    id: string;
    name: string;
    brand: string;
    category: string;
    price: number;
    stock: number;
    isVisible: boolean;
    version: number;
    sku?: string;
    imageUrl?: string;
    compareAtPrice?: number;
    sizes: string;
    description: string;
    isFeatured: boolean;
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
    deckSpec?: DeckSpec;
    deckSpecsBySize?: Readonly<Record<string, DeckSpec>>;
    sizeChart?: Readonly<{ kind: SizeChartKind; values: SizeChartValues }>;
    sizeChartKind?: SizeChartKind;
    sizeChartsBySize?: Readonly<Record<string, SizeChartValues>>;
  }>[];
  products: readonly Readonly<{
    id: string;
    name: string;
    brand: string;
    category: string;
    price: number;
    stock: number;
    isVisible: boolean;
    version: number;
    sku?: string;
    imageUrl?: string;
    compareAtPrice?: number;
    sizes: string;
    description: string;
    isFeatured: boolean;
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
    deckSpec?: DeckSpec;
    deckSpecsBySize?: Readonly<Record<string, DeckSpec>>;
    sizeChart?: Readonly<{ kind: SizeChartKind; values: SizeChartValues }>;
    sizeChartKind?: SizeChartKind;
    sizeChartsBySize?: Readonly<Record<string, SizeChartValues>>;
  }>[];
  selectedIds: ReadonlySet<string>;
  applySelection: (productId: string, mode: "add" | "remove") => void;
  handleSelectPointerDown: (
    productId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  handleSelectPointerEnter: (productId: string) => void;
  onEditProduct: (product: AdminCatalogListItem) => void;
}>) {
  return (
    <div className={`${styles.sectionStack} ${styles.productScreen}`}>
      {productStepper}
      <div className={`${styles.productListHeader} ${adminSharedStyles.wrapRow}`}>
        <div className={adminProductSectionStyles.productPageHeading}>
          <h2>{isKorean ? "상품 관리" : "Products"}</h2>
          <p>
            {isKorean
              ? "상품의 공개 상태와 재고를 확인하세요."
              : "Check each product's visibility and stock."}
          </p>
        </div>
        <div className={adminProductSectionStyles.productListHeaderActions}>
          <AdminGuideButton
            locale={locale}
            steps={adminGuideSteps("products", locale)}
          />
          <button
            aria-label={isKorean ? "새 상품 등록" : "Register new product"}
            className={styles.addProductButton}
            onClick={onOpenCreate}
            type="button"
          >
            <span aria-hidden="true">＋</span> {isKorean ? "새 상품" : "New product"}
          </button>
        </div>
      </div>
      {notice ? <NoticeMessage notice={notice} /> : null}
      <div className={styles.productToolbar}>
        <label className={styles.productFilterSearch}>
          <span className={adminSharedStyles.srOnly}>
            {isKorean ? "상품 검색" : "Search products"}
          </span>
          <input
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={
              isKorean ? "상품명 · 브랜드 · SKU 검색" : "Search name · brand · SKU"
            }
            type="search"
            value={filterQuery}
          />
        </label>
        <label className={styles.productFilterSelect}>
          <span>{isKorean ? "상태" : "Status"}</span>
          <select
            onChange={(event) =>
              setStatusFilter(event.target.value as "all" | "published" | "draft")
            }
            value={statusFilter}
          >
            <option value="all">{isKorean ? "전체" : "All"}</option>
            <option value="published">{isKorean ? "공개" : "Public"}</option>
            <option value="draft">{isKorean ? "비공개" : "Private"}</option>
          </select>
        </label>
        <label className={styles.productFilterSelect}>
          <span>{isKorean ? "재고" : "Stock"}</span>
          <select
            onChange={(event) =>
              setStockFilter(event.target.value as "all" | "inStock" | "soldOut")
            }
            value={stockFilter}
          >
            <option value="all">{isKorean ? "전체" : "All"}</option>
            <option value="inStock">{isKorean ? "재고 있음" : "In stock"}</option>
            <option value="soldOut">{isKorean ? "품절" : "Sold out"}</option>
          </select>
        </label>
      </div>
      <div className={styles.productSelectionBar}>
        <button
          aria-pressed={allFilteredSelected}
          className={styles.productSelectAllHit}
          onClick={toggleSelectAllFiltered}
          type="button"
        >
          <span
            aria-hidden="true"
            aria-checked={allFilteredSelected}
            className={adminProductSectionStyles.productCheckbox}
          />
          <span>{isKorean ? "전체 선택" : "Select all"}</span>
        </button>
        <button
          className={styles.productBulkDeleteButton}
          disabled={deleting || selectedProducts.length === 0}
          onClick={() =>
            onDeleteProducts(
              selectedProducts.map((product) => ({
                id: product.id,
                version: product.version,
              })),
            )
          }
          type="button"
        >
          {deleting
            ? isKorean
              ? "삭제 중…"
              : "Deleting…"
            : selectedProducts.length > 0
              ? isKorean
                ? `선택 삭제 (${selectedProducts.length})`
                : `Delete selected (${selectedProducts.length})`
              : isKorean
                ? "선택 삭제"
                : "Delete selected"}
        </button>
      </div>
      {loading ? (
        <p className={styles.productListEmpty}>
          {isKorean ? "상품 목록을 불러오는 중…" : "Loading products…"}
        </p>
      ) : filteredProducts.length === 0 ? (
        <p className={styles.productListEmpty}>
          {products.length === 0
            ? isKorean
              ? "아직 등록된 상품이 없습니다. 새 상품을 추가해 보세요."
              : "No products yet. Add a new product."
            : isKorean
              ? "필터 조건에 맞는 상품이 없습니다."
              : "No products match the filters."}
        </p>
      ) : (
        <ul
          aria-label={isKorean ? "상품 목록" : "Product list"}
          className={styles.productList}
          data-admin-guide="products.list"
        >
          {filteredProducts.map((product) => {
            const isSelected = selectedIds.has(product.id);

            return (
              <li
                className={
                  isSelected
                    ? `${styles.productListItem} ${adminProductSectionStyles.productListItemSelected}`
                    : styles.productListItem
                }
                key={product.id}
              >
                <button
                  aria-label={
                    isKorean ? `${product.name} 선택` : `Select ${product.name}`
                  }
                  aria-pressed={isSelected}
                  className={styles.productSelectHit}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      applySelection(product.id, isSelected ? "remove" : "add");
                    }
                  }}
                  onPointerDown={(event) => handleSelectPointerDown(product.id, event)}
                  onPointerEnter={() => handleSelectPointerEnter(product.id)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    aria-checked={isSelected}
                    className={adminProductSectionStyles.productCheckbox}
                  />
                </button>
                <div className={styles.productListIdentity}>
                  <AdminProductImage alt="" compact src={product.imageUrl} />
                  <div className={styles.productListMain}>
                    <strong>{product.name}</strong>
                    <span>
                      {product.brand} · {product.category}
                    </span>
                    {product.sku ? <small>{product.sku}</small> : null}
                  </div>
                </div>
                <div className={styles.productRowMeta}>
                  <span className={styles.productStock}>
                    {isKorean ? "재고" : "Stock"} {product.stock}{" "}
                    <StockStatusBadge locale={locale} stock={product.stock} />
                  </span>
                  <span className={styles.productPrice}>
                    {moneyFormatter.format(product.price)}
                  </span>
                  <span
                    className={
                      product.isVisible && product.version > 0
                        ? styles.publicStatus
                        : styles.draftStatus
                    }
                  >
                    {product.version <= 0
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
                <div className={styles.productRowActions}>
                  <button
                    className={styles.productRowEditButton}
                    onClick={() => onEditProduct(product)}
                    type="button"
                  >
                    {isKorean ? "수정" : "Edit"}
                  </button>
                  <button
                    className={styles.productRowDeleteButton}
                    disabled={deleting}
                    onClick={() =>
                      onDeleteProducts([{ id: product.id, version: product.version }])
                    }
                    type="button"
                  >
                    {isKorean ? "삭제" : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
