import {
  MAX_INLINE_OCR_IMAGE_BYTES,
  type ValidatedOcrImage,
  type OcrImageUploadParseResult,
} from "./paddle-ocr.js";

const MAX_FILE_NAME_LENGTH = 120;

// 브라우저와 같은 자모 범위만 허용하며 파일명 정규화·변환은 하지 않음.
const OCR_FILE_NAME_PATTERN =
  /^[A-Za-z0-9가-힣\u1100-\u11ff\u3131-\u318e\ua960-\ua97c\ud7b0-\ud7c6\ud7cb-\ud7fb][A-Za-z0-9가-힣\u1100-\u11ff\u3131-\u318e\ua960-\ua97c\ud7b0-\ud7c6\ud7cb-\ud7fb._ -]*$/;

export function readSupportedMimeType(
  value: unknown,
): ValidatedOcrImage["mimeType"] | undefined {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp"
    ? value
    : undefined;
}

type Base64InputReadResult =
  | Readonly<{ kind: "valid"; base64: string }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "too-large" }>;

type Base64DecodeResult =
  | Readonly<{ kind: "valid"; bytes: Buffer }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "too-large" }>;

/**
 * data URI는 declared MIME과 정확히 일치할 때만 풀고, raw base64는 길이부터 제한합니다.
 * 큰 base64 문자열에 전체 정규식을 적용하면 V8이 RangeError를 낼 수 있어 사용하지 않습니다.
 */
export function readImageBase64(
  value: unknown,
  mimeType: ValidatedOcrImage["mimeType"],
): Base64InputReadResult {
  if (typeof value !== "string") {
    return { kind: "invalid" };
  }

  const dataUriPrefix = `data:${mimeType};base64,`;
  const base64 = value.startsWith("data:")
    ? value.startsWith(dataUriPrefix)
      ? value.slice(dataUriPrefix.length)
      : undefined
    : value;

  if (!base64) {
    return { kind: "invalid" };
  }

  if (base64.length > maxBase64Length()) {
    return { kind: "too-large" };
  }

  return { kind: "valid", base64 };
}

/** base64 alphabet·padding을 선형 charCode 검사로 확인해 대형 유효 payload에서도 안전하게 동작합니다. */
export function decodeBase64Image(base64: string): Base64DecodeResult {
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    base64.length > maxBase64Length() ||
    !isCanonicalBase64(base64)
  ) {
    return { kind: "invalid" };
  }

  const paddingLength = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const expectedByteLength = (base64.length / 4) * 3 - paddingLength;

  if (expectedByteLength < 1) {
    return { kind: "invalid" };
  }

  // 마지막 4-char quantum은 4MiB보다 최대 2B 클 수 있어 이 작은 decode 뒤 실제 raw 길이로 판정합니다.
  if (expectedByteLength > MAX_INLINE_OCR_IMAGE_BYTES + 2) {
    return { kind: "too-large" };
  }

  try {
    const bytes = Buffer.from(base64, "base64");

    if (bytes.length !== expectedByteLength) {
      return { kind: "invalid" };
    }

    return bytes.length > MAX_INLINE_OCR_IMAGE_BYTES
      ? { kind: "too-large" }
      : { kind: "valid", bytes };
  } catch {
    return { kind: "invalid" };
  }
}

function isCanonicalBase64(value: string): boolean {
  let paddingStart = value.length;

  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index);

    if (characterCode === 0x3d) {
      paddingStart = index;
      break;
    }

    if (getBase64AlphabetValue(characterCode) < 0) {
      return false;
    }
  }

  const paddingLength = value.length - paddingStart;

  if (paddingLength > 2) {
    return false;
  }

  for (let index = paddingStart; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) {
      return false;
    }
  }

  if (paddingLength === 0) {
    return true;
  }

  const finalAlphabetValue = getBase64AlphabetValue(value.charCodeAt(paddingStart - 1));

  if (finalAlphabetValue < 0) {
    return false;
  }

  return paddingLength === 1
    ? (finalAlphabetValue & 0b11) === 0
    : (finalAlphabetValue & 0b1111) === 0;
}

function getBase64AlphabetValue(characterCode: number): number {
  if (characterCode >= 0x41 && characterCode <= 0x5a) {
    return characterCode - 0x41;
  }

  if (characterCode >= 0x61 && characterCode <= 0x7a) {
    return characterCode - 0x61 + 26;
  }

  if (characterCode >= 0x30 && characterCode <= 0x39) {
    return characterCode - 0x30 + 52;
  }

  if (characterCode === 0x2b) {
    return 62;
  }

  return characterCode === 0x2f ? 63 : -1;
}

export function detectImageMimeType(
  bytes: Buffer,
): ValidatedOcrImage["mimeType"] | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}

export function readSafeOcrFileName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FILE_NAME_LENGTH ||
    value !== value.trim() ||
    !OCR_FILE_NAME_PATTERN.test(value)
  ) {
    return undefined;
  }

  return value;
}

function maxBase64Length() {
  return Math.ceil(MAX_INLINE_OCR_IMAGE_BYTES / 3) * 4;
}

export function invalidOcrImage(): OcrImageUploadParseResult {
  return { ok: false, code: "OCR_IMAGE_INVALID" };
}
