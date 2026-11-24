"use client";
import adminBrandSectionStyles from "./admin-brand-section.module.css";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { adminGuideSteps } from "@/lib/admin-ui/admin-guides";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import { useState, type FormEvent } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminGuideButton } from "./admin-guide";
import { AdminHelpButton } from "./admin-help-button";
import { GrowingLineInput } from "./admin-product-name-input";
import requiredStyles from "./admin-required.module.css";
import { EmptyState, Notice, NoticeMessage } from "./admin-shared";
import { AdminStepper, type AdminStep } from "./admin-stepper";

export function BrandSection({
  brandMemo,
  brandName,
  brands,
  canSaveToServer,
  loadFailed,
  loading,
  notice,
  onMemoChange,
  onNameChange,
  onSubmit,
  products,
  saving,
}: Readonly<{
  brandMemo: string;
  brandName: string;
  brands: readonly string[];
  canSaveToServer: boolean;
  loadFailed: boolean;
  loading: boolean;
  notice: Notice;
  onMemoChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  products: readonly AdminCatalogListItem[];
  saving: boolean;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "linked" | "unlinked">("all");
  const brandMap = new Map<
    string,
    { name: string; productCount: number; addedHere: boolean }
  >();
  for (const product of products) {
    const name = product.brand.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = brandMap.get(key) ?? { name, productCount: 0, addedHere: false };
    entry.productCount += 1;
    brandMap.set(key, entry);
  }
  for (const brand of brands) {
    const name = brand.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = brandMap.get(key) ?? { name, productCount: 0, addedHere: false };
    entry.addedHere = true;
    brandMap.set(key, entry);
  }
  const entries = [...brandMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ko"),
  );
  const linkedCount = entries.filter((entry) => entry.productCount > 0).length;
  const matching = entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "linked" ? entry.productCount > 0 : entry.productCount === 0)),
  );
  const counts = {
    all: entries.length,
    linked: linkedCount,
    unlinked: entries.length - linkedCount,
  };
  const previewName = brandName.trim() || (isKorean ? "브랜드명" : "Brand name");
  const emptyTitle = loading
    ? isKorean
      ? "상품의 브랜드를 불러오고 있습니다"
      : "Loading brands from products"
    : loadFailed && entries.length === 0
      ? isKorean
        ? "브랜드 목록을 확인하지 못했습니다"
        : "Could not check the brand list"
      : entries.length
        ? isKorean
          ? "조건에 맞는 브랜드가 없습니다"
          : "No brands match"
        : isKorean
          ? "현재 이 화면에 표시할 브랜드가 없습니다"
          : "No brands to show on this screen";
  const emptyDescription = loading
    ? isKorean
      ? "조회가 끝나면 이 화면의 상품 기준으로 표시합니다."
      : "Once loaded, brands are shown based on the products on this screen."
    : loadFailed && entries.length === 0
      ? isKorean
        ? "조회 실패는 브랜드가 없다는 뜻이 아닙니다. 연결과 상품 목록을 확인해 주세요."
        : "A failed load does not mean there are no brands. Check the connection and product list."
      : entries.length
        ? isKorean
          ? "검색어나 상품 연결 필터를 바꿔 보세요."
          : "Try a different search or link filter."
        : isKorean
          ? "브랜드를 추가하면 이 화면의 상품 등록에서 선택할 수 있습니다."
          : "Once added, a brand can be chosen in product registration on this screen.";

  const brandListReady = !loading && !loadFailed;
  const brandSaved = notice?.kind === "success" && !saving;
  const brandSteps: AdminStep[] = [
    {
      label: isKorean ? "브랜드 목록 확인" : "Check brand list",
      state: brandListReady ? "complete" : "current",
    },
    {
      label: isKorean ? "브랜드 입력" : "Enter brand",
      state: !brandListReady
        ? "upcoming"
        : brandSaved || saving || brandName.trim()
          ? "complete"
          : "current",
    },
    {
      label: isKorean ? "브랜드 저장" : "Save brand",
      state: !canSaveToServer
        ? "unavailable"
        : brandSaved
          ? "complete"
          : saving || (brandListReady && brandName.trim())
            ? "current"
            : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.brandScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label={isKorean ? "브랜드 작업 흐름" : "Brand workflow"}
        locale={locale}
        steps={brandSteps}
      />
      <header className={adminBrandSectionStyles.brandHeader}>
        <div>
          <p>{isKorean ? "상품·재고 / 브랜드" : "Products & stock / Brands"}</p>
          <h2>{isKorean ? "브랜드 관리" : "Brands"}</h2>
        </div>
        <AdminGuideButton locale={locale} steps={adminGuideSteps("brands", locale)} />
      </header>
      <div className={adminBrandSectionStyles.brandWorkspace}>
        <section
          className={adminBrandSectionStyles.brandCatalog}
          aria-labelledby="brand-list-title"
          data-admin-guide="brands.list"
        >
          <div className={adminBrandSectionStyles.brandCatalogHeading}>
            <div className={adminSharedStyles.titleWithHelp}>
              <h3 id="brand-list-title">
                {isKorean ? "이 화면에서 확인한 브랜드" : "Brands found on this screen"}
              </h3>
              <AdminHelpButton
                locale={locale}
                target={isKorean ? "브랜드 목록" : "Brand list"}
              >
                <p>
                  {isKorean
                    ? "현재 불러온 상품과 이 화면에서 추가한 브랜드만 표시합니다. 전체 브랜드 목록이나 서버의 활성 상태를 조회하는 화면은 아닙니다."
                    : "Shows only brands from the loaded products and brands added on this screen. This screen does not load the full brand list or server status."}
                </p>
                <p>
                  {isKorean
                    ? "상품 연결 수는 이 화면의 상품 기준입니다. 연결이 없어도 비활성 브랜드를 뜻하지 않습니다. 로고 업로드·브랜드 수정·삭제는 지원하지 않습니다."
                    : "Linked product counts are based on the products on this screen. No link does not mean the brand is inactive. Logo upload, brand edit and delete are not supported."}
                </p>
              </AdminHelpButton>
            </div>
            <p>
              {isKorean
                ? "조회 상품·이 화면 추가분 기준 · 전체 목록 아님"
                : "From loaded products and additions here · Not the full list"}
            </p>
          </div>
          <label className={adminBrandSectionStyles.brandSearch}>
            <span>{isKorean ? "브랜드명 검색" : "Search brand name"}</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder={isKorean ? "브랜드명으로 검색" : "Search by brand name"}
              type="search"
              value={search}
            />
          </label>
          <div
            className={adminBrandSectionStyles.brandFilters}
            role="group"
            aria-label={isKorean ? "상품 연결 필터" : "Product link filter"}
          >
            {(
              [
                ["all", isKorean ? "전체" : "All"],
                ["linked", isKorean ? "상품 연결" : "Linked"],
                ["unlinked", isKorean ? "연결 없음" : "Not linked"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {label}{" "}
                <span>
                  {(loading || loadFailed) && entries.length === 0
                    ? "—"
                    : counts[value]}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <p className={adminBrandSectionStyles.brandListNotice} role="status">
              {isKorean
                ? "상품의 브랜드를 불러오는 중…"
                : "Loading brands from products…"}
            </p>
          ) : loadFailed ? (
            <p className={adminBrandSectionStyles.brandListError} role="alert">
              {isKorean
                ? "상품 목록을 불러오지 못했습니다. 아래 연결 수는 현재 이 화면에 남은 상품만 기준으로 하며 전체 수량이 아닙니다."
                : "Could not load the product list. The link counts below use only the products left on this screen and are not totals."}
            </p>
          ) : null}
          {matching.length === 0 ? (
            <EmptyState title={emptyTitle} description={emptyDescription} />
          ) : (
            <div className={adminBrandSectionStyles.brandTableWrap}>
              <table className={adminBrandSectionStyles.brandTable}>
                <caption>
                  {isKorean
                    ? "브랜드별 이 화면 상품 연결"
                    : "Products linked per brand on this screen"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{isKorean ? "브랜드" : "Brand"}</th>
                    <th scope="col">{isKorean ? "연결 상품 수" : "Linked products"}</th>
                    <th scope="col">{isKorean ? "확인 출처" : "Source"}</th>
                  </tr>
                </thead>
                <tbody>
                  {matching.map((entry) => (
                    <tr key={entry.name.toLowerCase()}>
                      <th scope="row">
                        <span className={adminBrandSectionStyles.brandRowIdentity}>
                          <span
                            className={adminBrandSectionStyles.brandTextMark}
                            aria-hidden="true"
                          >
                            {entry.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span>{entry.name}</span>
                        </span>
                      </th>
                      <td>
                        <strong>
                          {isKorean ? `${entry.productCount}개` : entry.productCount}
                        </strong>
                        <span>
                          {entry.productCount > 0
                            ? isKorean
                              ? "상품 연결"
                              : "Linked"
                            : isKorean
                              ? "연결 없음"
                              : "Not linked"}
                        </span>
                      </td>
                      <td>
                        {entry.addedHere
                          ? isKorean
                            ? "이 화면에서 추가"
                            : "Added here"
                          : isKorean
                            ? "상품에서 확인"
                            : "From products"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <form
          aria-label={isKorean ? "브랜드 추가" : "Add brand"}
          className={adminBrandSectionStyles.brandForm}
          noValidate
          onSubmit={onSubmit}
        >
          <div className={adminBrandSectionStyles.brandFormHeading}>
            <div className={adminSharedStyles.titleWithHelp}>
              <h3>{isKorean ? "브랜드 추가" : "Add brand"}</h3>
              {canSaveToServer ? (
                <span className={adminSharedStyles.fieldHelp}>
                  <AdminHelpButton
                    locale={locale}
                    target={isKorean ? "브랜드 추가" : "Add brand"}
                  >
                    <p>
                      {isKorean
                        ? "저장하면 서버에 브랜드가 등록됩니다."
                        : "Saving registers the brand on the server."}
                    </p>
                  </AdminHelpButton>
                </span>
              ) : null}
            </div>
            <span>
              {saving
                ? isKorean
                  ? "등록 중…"
                  : "Registering…"
                : canSaveToServer
                  ? isKorean
                    ? "등록 전"
                    : "Not registered"
                  : isKorean
                    ? "서버 미연결"
                    : "No server"}
            </span>
          </div>
          {canSaveToServer ? null : (
            <p className={adminBrandSectionStyles.brandSaveHint}>
              {isKorean
                ? "서버 연결이 없어 이 화면에만 임시 추가합니다."
                : "Without a server connection, it is added on this screen only."}
            </p>
          )}
          <fieldset disabled={saving} className={adminBrandSectionStyles.brandFields}>
            <label>
              <span>
                {isKorean ? "브랜드명" : "Brand name"}{" "}
                <span className={adminBrandSectionStyles.brandRequired}>
                  {isKorean ? "(필수)" : "(required)"}
                </span>
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <GrowingLineInput
                data-admin-guide="brands.name"
                maxLength={100}
                required
                onValueChange={onNameChange}
                placeholder={isKorean ? "예: April" : "e.g. April"}
                value={brandName}
              />
            </label>
            <label>
              <span>{isKorean ? "운영 메모 (선택)" : "Note (optional)"}</span>
              <textarea
                maxLength={1_000}
                onChange={(event) => onMemoChange(event.target.value)}
                placeholder={
                  isKorean
                    ? "운영 시 참고할 내용 · 개인정보 제외"
                    : "Notes for operations · No personal data"
                }
                rows={4}
                value={brandMemo}
              />
            </label>
            <section
              className={adminBrandSectionStyles.brandPreview}
              aria-label={
                isKorean ? "브랜드명 표시 예시" : "Brand name display example"
              }
            >
              <h4>{isKorean ? "브랜드명 표시 예시" : "Brand name display example"}</h4>
              <div>
                <strong>{previewName}</strong>
                <span>
                  {isKorean
                    ? "상품의 브랜드명에 사용"
                    : "Used as the product's brand name"}
                </span>
              </div>
              <p>
                {isKorean
                  ? "텍스트 표시 예시이며 실제 로고나 공개 화면이 아닙니다."
                  : "A text example, not an actual logo or public screen."}
              </p>
            </section>
            <div className={styles.brandFormActions}>
              <button
                className={styles.primaryButton}
                data-admin-guide="brands.save"
                type="submit"
              >
                {saving
                  ? isKorean
                    ? "등록 중…"
                    : "Registering…"
                  : canSaveToServer
                    ? isKorean
                      ? "브랜드 등록"
                      : "Register brand"
                    : isKorean
                      ? "이 화면에 임시 추가"
                      : "Add here temporarily"}
              </button>
              <button
                className={styles.secondaryButton}
                onClick={() => {
                  onNameChange("");
                  onMemoChange("");
                }}
                type="button"
              >
                {isKorean ? "입력 지우기" : "Clear input"}
              </button>
            </div>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
      </div>
    </div>
  );
}
