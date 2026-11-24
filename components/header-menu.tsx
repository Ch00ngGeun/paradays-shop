"use client";

import type { Dispatch, SetStateAction } from "react";

import type { useCatalogFilter } from "@/contexts/catalog-filter-context";
import { menuGroups, menuLeafTops, menuRootAll } from "@/data/navigation";
import type { Locale } from "@/types/store";

import styles from "./header.module.css";

export function HeaderMenuDropdown({
  isSelected,
  locale,
  isMenuOpen,
  setIsMenuMounted,
  isMenuVisible,
  handleMenuSelection,
}: Readonly<{
  isSelected: ReturnType<typeof useCatalogFilter>["isSelected"];
  locale: Locale;
  isMenuOpen: boolean;
  setIsMenuMounted: Dispatch<SetStateAction<boolean>>;
  isMenuVisible: boolean;
  handleMenuSelection: (itemId: string) => void;
}>) {
  return (
    <div
      className={
        isMenuVisible
          ? `${styles.menuDropdown} ${styles.menuDropdownVisible}`
          : styles.menuDropdown
      }
      id="store-menu-dropdown"
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== "opacity" ||
          isMenuOpen ||
          isMenuVisible
        ) {
          return;
        }

        setIsMenuMounted(false);
      }}
    >
      {/* 상단: All | Clothes | SkateBoard | SALE */}
      <section className={`${styles.leafTopSection} ${styles.menuAll}`}>
        <button
          aria-pressed={isSelected(menuRootAll.id)}
          className={styles.leafTopButton}
          data-menu-item
          onClick={() => handleMenuSelection(menuRootAll.id)}
          type="button"
        >
          {menuRootAll.label[locale]}
        </button>
      </section>

      {menuGroups
        .filter((group) => group.id !== "brand")
        .map((group) => (
          <section
            className={
              group.id === "clothes"
                ? styles.menuClothes
                : group.id === "skateboard"
                  ? styles.menuSkate
                  : undefined
            }
            key={group.id}
          >
            <p className={styles.groupHeading}>{group.label[locale]}</p>
            {group.items.map((item) => (
              <button
                aria-pressed={isSelected(item.id)}
                data-menu-item
                key={item.id}
                onClick={() => handleMenuSelection(item.id)}
                type="button"
              >
                {item.label[locale]}
              </button>
            ))}
          </section>
        ))}

      {menuLeafTops.map((item) => (
        <section
          className={`${styles.leafTopSection} ${styles.menuSale}`}
          key={item.id}
        >
          <button
            aria-pressed={isSelected(item.id)}
            className={styles.leafTopButton}
            data-menu-item
            onClick={() => handleMenuSelection(item.id)}
            type="button"
          >
            {item.label[locale]}
          </button>
        </section>
      ))}

      {/* 하단: Brand — Clothes 아래부터 가로로 펼쳐 스크롤 없이 표시 */}
      {menuGroups
        .filter((group) => group.id === "brand")
        .map((group) => (
          <section className={styles.brandSection} key={group.id}>
            <p className={styles.groupHeading}>{group.label[locale]}</p>
            <div className={styles.brandItems}>
              {group.items.map((item) => (
                <button
                  aria-pressed={isSelected(item.id)}
                  data-menu-item
                  key={item.id}
                  onClick={() => handleMenuSelection(item.id)}
                  type="button"
                >
                  {item.label[locale]}
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
