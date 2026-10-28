// 역할: 브라우저에서 OCR 입력 파일과 검토 행을 서버 계약과 같은 제한으로 먼저 검증합니다.
// 기능: private OCR credential 없이 MIME·매직 바이트·안전한 inline 전송 크기만 확인합니다.
import type { Locale } from "@/types/store";

export const OCR_INPUT_LIMITS = {
  maxFileNameLength: 120,
  maxInlineImageBytes: 4 * 1024 * 1024,
  // 6MiB 원본 정책은 private S3 presigned upload 경로가 구현된 뒤에만 적용합니다.
  maxPresignedImageBytes: 6 * 1024 * 1024,
  maxReviewRows: 500,
  maxRawTextLength: 100_000,
  maxSourceTextLength: 1_000,
  maxProductNameLength: 240,
  maxBrandLength: 100,
  maxOptionLength: 200,
  maxQuantityDigits: 9,
} as const;

export type OcrImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export type AdminOcrInputErrorReason =
  | "FILE_NAME_INVALID"
  | "FILE_TYPE_INVALID"
  | "FILE_TOO_LARGE"
  | "INLINE_PAYLOAD_TOO_LARGE"
  | "FILE_READ_FAILED"
  | "IMAGE_SIGNATURE_INVALID";

/** UI가 안전한 안내만 표시할 수 있는 OCR 파일 검증 오류입니다. */
export class AdminOcrInputError extends Error {
  readonly code = "ADMIN_OCR_INPUT_INVALID";

  constructor(readonly reason: AdminOcrInputErrorReason) {
    super(`ADMIN_OCR_INPUT_INVALID:${reason}`);
    this.name = "AdminOcrInputError";
  }
}

export type ValidatedOcrImageFile = Readonly<{
  fileName: string;
  mimeType: OcrImageMimeType;
  bytes: Uint8Array;
}>;

// 분리형·호환·옛한글 자모도 원문 그대로 허용함. 다른 결합 문자로 범위를 넓히지 않음.
const OCR_FILE_NAME_PATTERN =
  /^[A-Za-z0-9가-힣\u1100-\u11ff\u3131-\u318e\ua960-\ua97c\ud7b0-\ud7c6\ud7cb-\ud7fb][A-Za-z0-9가-힣\u1100-\u11ff\u3131-\u318e\ua960-\ua97c\ud7b0-\ud7c6\ud7cb-\ud7fb._ -]*$/;

/** 선택 직후와 OCR 전송 직전에 같은 파일 정책을 반복 적용합니다. */
export async function validateOcrImageFile(file: File): Promise<ValidatedOcrImageFile> {
  if (!isFileLike(file)) {
    throw new AdminOcrInputError("FILE_READ_FAILED");
  }

  if (!isSafeOcrFileName(file.name)) {
    throw new AdminOcrInputError("FILE_NAME_INVALID");
  }

  if (!isOcrImageMimeType(file.type)) {
    throw new AdminOcrInputError("FILE_TYPE_INVALID");
  }

  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    throw new AdminOcrInputError("FILE_READ_FAILED");
  }

  if (file.size > OCR_INPUT_LIMITS.maxPresignedImageBytes) {
    throw new AdminOcrInputError("FILE_TOO_LARGE");
  }

  // Lambda sync payload 한도보다 먼저 차단합니다. 4–6MiB는 아직 S3 전환 전이라 보내지 않습니다.
  if (file.size > OCR_INPUT_LIMITS.maxInlineImageBytes) {
    throw new AdminOcrInputError("INLINE_PAYLOAD_TOO_LARGE");
  }

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AdminOcrInputError("FILE_READ_FAILED");
  }

  if (bytes.length !== file.size || !hasMatchingOcrImageSignature(bytes, file.type)) {
    throw new AdminOcrInputError("IMAGE_SIGNATURE_INVALID");
  }

  return { fileName: file.name, mimeType: file.type, bytes };
}

/** 서버가 같은 행 제한을 적용하므로 저장 요청 전에 운영자가 바로 수정할 수 있게 안내합니다. */
export function getOcrReviewRowValidationMessage(
  rows: ReadonlyArray<
    Readonly<{
      sourceText: string;
      productName: string;
      brand: string;
      option: string;
      quantity: string;
    }>
  >,
  locale: Locale = "ko",
): string | undefined {
  const isKorean = locale === "ko";
  if (rows.length === 0 || rows.length > OCR_INPUT_LIMITS.maxReviewRows) {
    return isKorean
      ? `검토 행은 1~${OCR_INPUT_LIMITS.maxReviewRows}개만 저장할 수 있습니다.`
      : `You can save only 1–${OCR_INPUT_LIMITS.maxReviewRows} review rows.`;
  }

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;

    if (!isOcrEditableText(row.sourceText, OCR_INPUT_LIMITS.maxSourceTextLength)) {
      return isKorean
        ? `${rowNumber}번째 원문은 ${OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("ko-KR")}자 이하로 입력해 주세요.`
        : `Enter row ${rowNumber} source text in ${OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("en-US")} characters or fewer.`;
    }

    if (!isOcrEditableText(row.productName, OCR_INPUT_LIMITS.maxProductNameLength)) {
      return isKorean
        ? `${rowNumber}번째 상품명은 ${OCR_INPUT_LIMITS.maxProductNameLength}자 이하로 입력해 주세요.`
        : `Enter row ${rowNumber} product name in ${OCR_INPUT_LIMITS.maxProductNameLength} characters or fewer.`;
    }

    if (!isOcrEditableText(row.brand, OCR_INPUT_LIMITS.maxBrandLength)) {
      return isKorean
        ? `${rowNumber}번째 브랜드는 ${OCR_INPUT_LIMITS.maxBrandLength}자 이하로 입력해 주세요.`
        : `Enter row ${rowNumber} brand in ${OCR_INPUT_LIMITS.maxBrandLength} characters or fewer.`;
    }

    if (!isOcrEditableText(row.option, OCR_INPUT_LIMITS.maxOptionLength)) {
      return isKorean
        ? `${rowNumber}번째 옵션은 ${OCR_INPUT_LIMITS.maxOptionLength}자 이하로 입력해 주세요.`
        : `Enter row ${rowNumber} option in ${OCR_INPUT_LIMITS.maxOptionLength} characters or fewer.`;
    }

    if (!isOcrQuantity(row.quantity)) {
      return isKorean
        ? `${rowNumber}번째 수량은 비우거나 0~999,999,999 정수로 입력해 주세요.`
        : `Leave row ${rowNumber} quantity empty or enter a whole number from 0 to 999,999,999.`;
    }
  }

  return undefined;
}

/** OCR 서버가 허용할 편집 문자열의 제어 문자·길이 제한을 브라우저도 동일하게 적용합니다. */
export function isOcrEditableText(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length <= maximumLength &&
    !value.includes("\u0000")
  );
}

/** 빈 수량은 검토 초안에서 허용하며, 값이 있으면 9자리 이하 정수만 허용합니다. */
export function isOcrQuantity(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^[0-9]{1,9}$/.test(value));
}

/** 파일 선택·전송 오류를 API 세부 정보 없이 운영자가 조치할 수 있는 문구로 바꿉니다. */
export function getOcrInputErrorMessage(
  error: unknown,
  locale: Locale = "ko",
): string | undefined {
  if (!(error instanceof AdminOcrInputError)) {
    return undefined;
  }
  const isKorean = locale === "ko";

  if (error.reason === "FILE_NAME_INVALID") {
    return isKorean
      ? "파일명은 120자 이하의 한글·영문·숫자·공백·._-만 사용할 수 있습니다."
      : "File names can use only Korean, English letters, digits, spaces and ._- within 120 characters.";
  }

  if (error.reason === "FILE_TYPE_INVALID") {
    return isKorean
      ? "OCR은 PNG, JPEG, WEBP 파일만 받을 수 있습니다."
      : "OCR accepts only PNG, JPEG and WEBP files.";
  }

  if (error.reason === "FILE_TOO_LARGE") {
    return isKorean
      ? "OCR 원본 파일은 6MiB를 초과할 수 없습니다."
      : "OCR source files cannot exceed 6MiB.";
  }

  if (error.reason === "INLINE_PAYLOAD_TOO_LARGE") {
    return isKorean
      ? "현재 직접 OCR은 4MiB 이하만 지원합니다. 4~6MiB 파일은 private S3 업로드 경로가 배포된 뒤 사용할 수 있습니다."
      : "Direct OCR currently supports files up to 4MiB. Files of 4–6MiB can be used after the private S3 upload path is deployed.";
  }

  if (error.reason === "IMAGE_SIGNATURE_INVALID") {
    return isKorean
      ? "선택한 파일의 실제 이미지 형식이 PNG, JPEG, WEBP MIME 정보와 일치하지 않습니다."
      : "The selected file's actual image format does not match its PNG, JPEG or WEBP MIME type.";
  }

  return isKorean
    ? "이미지 파일을 읽지 못했습니다. 파일을 다시 선택해 주세요."
    : "Could not read the image file. Choose the file again.";
}

/** 브라우저가 입력한 이름을 서버가 그대로 안전하게 저장 전 검증할 수 있는지 확인합니다. */
export function isSafeOcrFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= OCR_INPUT_LIMITS.maxFileNameLength &&
    value === value.trim() &&
    OCR_FILE_NAME_PATTERN.test(value)
  );
}

/** MIME claim만 신뢰하지 않고 파일 선두 바이트도 같은 이미지 형식인지 확인합니다. */
export function hasMatchingOcrImageSignature(
  bytes: Uint8Array,
  mimeType: OcrImageMimeType,
): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }

  if (mimeType === "image/jpeg") {
    return (
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    );
  }

  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

function isOcrImageMimeType(value: unknown): value is OcrImageMimeType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function isFileLike(value: unknown): value is Readonly<{
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "type" in value &&
    "size" in value &&
    "arrayBuffer" in value &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.size === "number" &&
    typeof value.arrayBuffer === "function"
  );
}
