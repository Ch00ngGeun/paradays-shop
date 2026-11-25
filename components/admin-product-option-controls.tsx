// 역할: 상품 편집 폼의 옵션 칩 입력. 데크 폭·휠 지름/경도 선택이나 직접 입력으로 옵션을 추가·삭제하고, 저장된 옵션 칩에서 상세사이즈 모달을 엽니다.
"use client";
import adminProductSectionStyles from "./admin-product-section.module.css";
import { useLocale } from "@/contexts/locale-context";
import {
  appendProductOption,
  formatProductDeckOption,
  formatProductWheelOption,
  listProductOptions,
  PRODUCT_DECK_WIDTHS,
  PRODUCT_WHEEL_DIAMETERS,
  PRODUCT_WHEEL_HARDNESSES,
} from "@/lib/admin-ui/product-form";
import { useRef, useState } from "react";
import styles from "./admin-dashboard.module.css";
import { AdminHelpButton } from "./admin-help-button";
import { localizedText, Notice } from "./admin-shared";

export function ProductOptionControls({
  category,
  chartOptions = [],
  editorId,
  onChange,
  onOpenOption,
  value,
}: Readonly<{
  category: string;
  /** 옵션별 상세사이즈가 저장된 옵션. 칩에 등록 표시를 붙입니다. */
  chartOptions?: readonly string[];
  editorId: string;
  onChange: (value: string) => void;
  /** 있으면 칩 이름이 버튼이 됩니다. 저장 전 칩처럼 열 수 없으면 false를 돌려줍니다. */
  onOpenOption?: (option: string) => boolean;
  value: string;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [deckWidth, setDeckWidth] = useState("");
  const [wheelDiameter, setWheelDiameter] = useState("");
  const [wheelHardness, setWheelHardness] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const options = listProductOptions(value);
  const chosen =
    category === "Deck"
      ? formatProductDeckOption(deckWidth)
      : category === "Wheels"
        ? formatProductWheelOption(wheelDiameter, wheelHardness)
        : null;
  // 입력한 글자가 선택값보다 우선해, 관리자가 입력칸에서 보는 값이 그대로 추가됩니다.
  const option = typed.trim() || chosen;
  const addOption = () => {
    if (!option) return;
    const result = appendProductOption(value, option);
    if (!result.ok) {
      setNotice({
        kind: "error",
        message:
          result.reason === "too-many-options"
            ? {
                ko: "옵션은 최대 20개까지 추가할 수 있습니다.",
                en: "You can add up to 20 options.",
              }
            : {
                ko: "각 옵션은 쉼표·줄바꿈 없이 50자 이하로 추가해 주세요.",
                en: "Add each option in 50 characters or fewer, without commas or line breaks.",
              },
      });
      return;
    }
    if (result.added) onChange(result.value);
    setNotice({
      kind: "success",
      message: result.added
        ? { ko: `${option} 옵션을 추가했습니다.`, en: `Added the ${option} option.` }
        : { ko: "이미 있는 옵션입니다.", en: "This option already exists." },
    });
    setTyped("");
    setDeckWidth("");
    setWheelDiameter("");
    setWheelHardness("");
  };
  // 위치로 지워서 "M, M, L" 같은 예전 중복 옵션도 칩 하나만 빠집니다.
  const removeOption = (index: number) => {
    const removed = options[index];
    onChange(options.filter((_, position) => position !== index).join(", "));
    setNotice({
      kind: "success",
      message: {
        ko: `${removed} 옵션을 뺐습니다. 상품을 저장하면 반영됩니다.`,
        en: `Removed the ${removed} option. It applies when the product is saved.`,
      },
    });
  };
  const addButton = (
    <button
      className={styles.secondaryButton}
      disabled={!option}
      onClick={addOption}
      type="button"
    >
      {isKorean ? "옵션 추가" : "Add option"}
    </button>
  );

  return (
    <div
      className={`${styles.productOptionField} ${category === "Deck" ? styles.productDeckField : ""}`}
    >
      <label htmlFor={`product-options-${editorId}`}>
        <span>{isKorean ? "사이즈 / 옵션" : "Size / options"}</span>
        <input
          data-admin-guide="products.options"
          id={`product-options-${editorId}`}
          onChange={(event) => {
            setNotice(null);
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter는 상품 폼을 제출하지 않고 입력한 옵션을 추가합니다. IME 조합 중인 Enter는 무시합니다.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            addOption();
          }}
          placeholder={category === "Wheels" ? "54mm / 99a" : "8.25”"}
          ref={inputRef}
          value={typed}
        />
      </label>
      {category === "Deck" ? (
        <div className={styles.productOptionPicker}>
          <select
            aria-label={isKorean ? "데크 규격 선택" : "Choose deck width"}
            onChange={(event) => {
              setDeckWidth(event.target.value);
              setNotice(null);
              if (event.target.value === "manual") inputRef.current?.focus();
            }}
            value={deckWidth}
          >
            <option value="">{isKorean ? "규격 선택" : "Choose width"}</option>
            {PRODUCT_DECK_WIDTHS.map((width) => (
              <option key={width} value={width}>
                {width}”
              </option>
            ))}
            <option value="manual">{isKorean ? "직접 입력" : "Enter manually"}</option>
          </select>
          {addButton}
        </div>
      ) : category === "Wheels" ? (
        <>
          <div className={styles.productWheelPicker}>
            <select
              aria-label={isKorean ? "바퀴 크기 선택" : "Choose wheel size"}
              onChange={(event) => {
                setWheelDiameter(event.target.value);
                setNotice(null);
              }}
              value={wheelDiameter}
            >
              <option value="">{isKorean ? "크기 선택" : "Choose size"}</option>
              {PRODUCT_WHEEL_DIAMETERS.map((diameter) => (
                <option key={diameter} value={diameter}>
                  {diameter}mm
                </option>
              ))}
            </select>
            <select
              aria-label={isKorean ? "경도 선택" : "Choose hardness"}
              onChange={(event) => {
                setWheelHardness(event.target.value);
                setNotice(null);
              }}
              value={wheelHardness}
            >
              <option value="">{isKorean ? "경도 선택" : "Choose hardness"}</option>
              {PRODUCT_WHEEL_HARDNESSES.map((hardness) => (
                <option key={hardness} value={hardness}>
                  {hardness}a
                </option>
              ))}
            </select>
          </div>
          {addButton}
        </>
      ) : (
        addButton
      )}
      {options.length ? (
        <ul
          aria-label={isKorean ? "추가된 옵션" : "Added options"}
          className={adminProductSectionStyles.productOptionChips}
        >
          {options.map((item, index) => {
            const markId = `${editorId}-option-${index}-chart`;
            const mark = chartOptions.includes(item) ? (
              <small className={styles.productOptionChipMark} id={markId}>
                {isKorean ? "상세" : "chart"}
              </small>
            ) : null;
            // 상자는 옵션 이름과 상세사이즈 표시만 감싸고, 삭제 버튼은 상자 바깥에 둡니다.
            return (
              <li
                className={adminProductSectionStyles.productOptionChip}
                key={`${index}:${item}`}
              >
                {onOpenOption ? (
                  <button
                    aria-describedby={mark ? markId : undefined}
                    aria-label={item}
                    className={styles.productOptionChipBox}
                    onClick={() => {
                      if (onOpenOption(item)) {
                        setNotice(null);
                        return;
                      }
                      setNotice({
                        kind: "error",
                        message: {
                          ko: "상품을 먼저 저장해 주세요. 저장된 옵션만 상세사이즈를 편집할 수 있습니다.",
                          en: "Save the product first. Only saved options can have a size chart edited.",
                        },
                      });
                    }}
                    type="button"
                  >
                    <span>{item}</span>
                    {mark}
                  </button>
                ) : (
                  <span className={styles.productOptionChipBox}>
                    <span>{item}</span>
                    {mark}
                  </span>
                )}
                <button
                  aria-label={isKorean ? `${item} 삭제` : `Remove ${item}`}
                  className={styles.productOptionChipRemove}
                  onClick={() => removeOption(index)}
                  type="button"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <span className={styles.fieldHelpCorner}>
        <AdminHelpButton
          locale={locale}
          target={isKorean ? "사이즈 / 옵션" : "Size / options"}
        >
          <p>
            {category === "Deck" || category === "Wheels"
              ? isKorean
                ? "직접 입력하거나 선택한 뒤 ‘옵션 추가’를 누르세요. 추가 전 입력값은 저장되지 않습니다."
                : "Type or choose, then press ‘Add option’. Nothing is saved until it is added."
              : isKorean
                ? "입력한 뒤 ‘옵션 추가’나 Enter를 누르세요."
                : "Type, then press ‘Add option’ or Enter."}
          </p>
          <p>
            {isKorean
              ? "옵션은 하나씩 추가 · 최대 20개 · 삭제는 상품 저장 때 반영"
              : "One option at a time · Up to 20 · Removals apply when the product is saved"}
          </p>
        </AdminHelpButton>
      </span>
      {notice ? (
        <small
          className={notice.kind === "error" ? styles.productOptionError : undefined}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {localizedText(notice.message, locale)}
        </small>
      ) : null}
    </div>
  );
}
