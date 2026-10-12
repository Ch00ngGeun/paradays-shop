// 역할: MyMemory 공개 번역 API로 KO↔EN 상품 문구를 변환함 (키 없이 사용 가능).

import type { Locale } from "@/types/store";

const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
/** MyMemory 권장 단일 요청 길이 상한에 맞춤 */
const MAX_CHUNK_CHARS = 450;

export type TranslateErrorCode =
  | "TRANSLATE_EMPTY"
  | "TRANSLATE_NETWORK"
  | "TRANSLATE_FAILED";

export class TranslateError extends Error {
  readonly code: TranslateErrorCode;

  constructor(code: TranslateErrorCode, message: string) {
    super(message);
    this.name = "TranslateError";
    this.code = code;
  }
}

/** 한글 포함 여부 — 소스 언어 보정용 */
export function containsHangul(value: string) {
  return /[\uAC00-\uD7A3]/.test(value);
}

function langPair(from: Locale, to: Locale) {
  return `${from}|${to}`;
}

function chunkText(value: string): string[] {
  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= MAX_CHUNK_CHARS) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_CHARS) {
      chunks.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf(" ", MAX_CHUNK_CHARS);

    if (cut < MAX_CHUNK_CHARS * 0.4) {
      cut = MAX_CHUNK_CHARS;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  return chunks.filter(Boolean);
}

async function translateChunk(
  text: string,
  from: Locale,
  to: Locale,
): Promise<string> {
  const url = new URL(MYMEMORY_ENDPOINT);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", langPair(from, to));

  let response: Response;

  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new TranslateError(
      "TRANSLATE_NETWORK",
      "번역 서버에 연결하지 못했습니다.",
    );
  }

  if (!response.ok) {
    throw new TranslateError(
      "TRANSLATE_FAILED",
      "번역 요청이 거절되었습니다.",
    );
  }

  const body: unknown = await response.json();

  if (
    typeof body !== "object" ||
    body === null ||
    !("responseData" in body) ||
    typeof (body as { responseData?: unknown }).responseData !== "object" ||
    (body as { responseData: unknown }).responseData === null
  ) {
    throw new TranslateError(
      "TRANSLATE_FAILED",
      "번역 응답 형식이 올바르지 않습니다.",
    );
  }

  const translated = (
    body as { responseData: { translatedText?: unknown }; responseStatus?: unknown }
  ).responseData.translatedText;

  if (typeof translated !== "string" || !translated.trim()) {
    throw new TranslateError("TRANSLATE_FAILED", "번역 결과를 받지 못했습니다.");
  }

  // MyMemory는 쿼터 초과 시 WARNING을 문장에 섞는 경우가 있음
  if (/MYMEMORY WARNING/i.test(translated)) {
    throw new TranslateError(
      "TRANSLATE_FAILED",
      "번역 일일 한도를 초과했습니다. 잠시 후 다시 시도하세요.",
    );
  }

  return translated.trim();
}

/** 단일 문자열을 from→to로 번역. 빈 값은 그대로 반환. */
export async function translateText(
  text: string,
  from: Locale,
  to: Locale,
): Promise<string> {
  const trimmed = text.trim();

  if (!trimmed) {
    return "";
  }

  if (from === to) {
    return trimmed;
  }

  const parts = chunkText(trimmed);
  const translated: string[] = [];

  for (const part of parts) {
    translated.push(await translateChunk(part, from, to));
  }

  return translated.join(" ").trim();
}

/** 줄 단위 설명(스펙)을 각각 번역. */
export async function translateLines(
  lines: readonly string[],
  from: Locale,
  to: Locale,
): Promise<string[]> {
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    result.push(await translateText(trimmed, from, to));
  }

  return result;
}

/**
 * 관리자 입력 언어(또는 한글 감지)를 소스로 삼아
 * name/description의 KO·EN 쌍을 만듦.
 */
export async function buildProductI18nFields(input: {
  name: string;
  descriptionLines: readonly string[];
  sourceLocale: Locale;
}): Promise<{
  name: string;
  description: string[];
  nameI18n: Readonly<{ en: string; ko: string }>;
  descriptionI18n: Readonly<{ en: string[]; ko: string[] }>;
}> {
  const name = input.name.trim();

  if (!name) {
    throw new TranslateError("TRANSLATE_EMPTY", "상품명이 비어 있습니다.");
  }

  const sourceLocale: Locale =
    input.sourceLocale === "ko" || containsHangul(name) ? "ko" : "en";
  const targetLocale: Locale = sourceLocale === "ko" ? "en" : "ko";

  const sourceDescription = input.descriptionLines
    .map((line) => line.trim())
    .filter(Boolean);

  const translatedName = await translateText(name, sourceLocale, targetLocale);
  const translatedDescription =
    sourceDescription.length > 0
      ? await translateLines(sourceDescription, sourceLocale, targetLocale)
      : [];

  const nameI18n =
    sourceLocale === "ko"
      ? { ko: name, en: translatedName }
      : { en: name, ko: translatedName };

  const descriptionI18n =
    sourceLocale === "ko"
      ? { ko: sourceDescription, en: translatedDescription }
      : { en: sourceDescription, ko: translatedDescription };

  // 레거시 단일 필드는 영문을 기본으로 두어 기존 영문 카탈로그와 맞춤.
  return {
    name: nameI18n.en || nameI18n.ko,
    description: descriptionI18n.en.length
      ? descriptionI18n.en
      : descriptionI18n.ko,
    nameI18n,
    descriptionI18n,
  };
}
