// 역할: OCR 직접 전송 경로가 Lambda sync payload에 안전한 4MiB 원본만 수용하는지 확인합니다.
import { describe, expect, it } from "vitest";

import {
  AdminOcrInputError,
  getOcrInputErrorMessage,
  getOcrReviewRowValidationMessage,
  isSafeOcrFileName,
  OCR_INPUT_LIMITS,
  validateOcrImageFile,
} from "@/lib/admin-ui/ocr-input-validation";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NFD_SCREENSHOT_NAME =
  "\u1109\u1173\u110f\u1173\u1105\u1175\u11ab\u1109\u1163\u11ba2.png";

function createPngFile(byteLength: number, name = "arrival.png") {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG_SIGNATURE);

  return new File([bytes], name, { type: "image/png" });
}

describe("validateOcrImageFile", () => {
  it("정확히 4MiB PNG 원본은 direct base64 전송 전 검증을 통과함", async () => {
    const file = createPngFile(OCR_INPUT_LIMITS.maxInlineImageBytes);

    await expect(validateOcrImageFile(file)).resolves.toMatchObject({
      fileName: "arrival.png",
      mimeType: "image/png",
      bytes: expect.objectContaining({
        length: OCR_INPUT_LIMITS.maxInlineImageBytes,
      }),
    });
  });

  it("4MiB를 한 바이트라도 넘는 원본은 아직 구현되지 않은 presigned 경로로 보내지 않고 차단함", async () => {
    const file = createPngFile(OCR_INPUT_LIMITS.maxInlineImageBytes + 1);

    await expect(validateOcrImageFile(file)).rejects.toMatchObject({
      name: "AdminOcrInputError",
      reason: "INLINE_PAYLOAD_TOO_LARGE",
    } satisfies Partial<AdminOcrInputError>);
  });

  it("경로 문자나 허용되지 않은 기호가 있는 파일명은 OCR 호출 전에 차단함", async () => {
    const file = createPngFile(8, "arrival@sheet.png");

    await expect(validateOcrImageFile(file)).rejects.toMatchObject({
      name: "AdminOcrInputError",
      reason: "FILE_NAME_INVALID",
    } satisfies Partial<AdminOcrInputError>);
  });
});

// These are signature fixtures, not decoded images. Pixel/header validation is
// deliberately exercised at the Python provider boundary instead of in the UI.
const FORMATS = [
  { mime: "image/png", bytes: PNG_SIGNATURE, name: "입고 목록.png" },
  {
    mime: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    name: "arrival.jpeg",
  },
  {
    mime: "image/webp",
    bytes: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
    name: "arrival.webp",
  },
] as const;

describe("OCR file boundary regression", () => {
  it("accepts a decomposed Hangul screenshot name and preserves every original code unit", async () => {
    const result = await validateOcrImageFile(createPngFile(8, NFD_SCREENSHOT_NAME));
    expect(result.fileName).toBe(NFD_SCREENSHOT_NAME);
    expect(result.fileName).not.toBe("스크린샷2.png");
    expect([...result.fileName].map((character) => character.charCodeAt(0))).toEqual(
      [...NFD_SCREENSHOT_NAME].map((character) => character.charCodeAt(0)),
    );
  });

  it.each([
    "\u1100",
    "\u11ff",
    "\u3131",
    "\u318e",
    "\ua960",
    "\ua97c",
    "\ud7b0",
    "\ud7c6",
    "\ud7cb",
    "\ud7fb",
  ])(
    "allows standalone Hangul jamo %s at the start or inside a file name",
    async (jamo) => {
      for (const name of [jamo + ".png", "image-" + jamo + ".png"]) {
        expect(isSafeOcrFileName(name)).toBe(true);
        await expect(
          validateOcrImageFile(createPngFile(8, name)),
        ).resolves.toMatchObject({
          fileName: name,
        });
      }
    },
  );

  it("keeps the limit at 120 original UTF-16 code units for decomposed Hangul", async () => {
    const name = "\u1100\u1161".repeat(58) + ".png";
    expect(name.length).toBe(120);
    await expect(validateOcrImageFile(createPngFile(8, name))).resolves.toMatchObject({
      fileName: name,
    });
    expect(isSafeOcrFileName("\u1100" + name)).toBe(false);
  });

  it.each([
    "../" + NFD_SCREENSHOT_NAME,
    "a/" + NFD_SCREENSHOT_NAME,
    "a\\" + NFD_SCREENSHOT_NAME,
    " " + NFD_SCREENSHOT_NAME,
    NFD_SCREENSHOT_NAME + " ",
    "." + NFD_SCREENSHOT_NAME,
    "_" + NFD_SCREENSHOT_NAME,
    "-" + NFD_SCREENSHOT_NAME,
    "a\u0000.png",
    "a\nb.png",
    "a\tb.png",
    "a\r.png",
    "😀.png",
    "e\u0301.png",
    "a\u200d.png",
    "a\u202e.png",
    "\u3130.png",
    "\u318f.png",
    "\ua97d.png",
    "\ud7c7.png",
    "\ud7fc.png",
  ])(
    "continues rejecting unsafe or unrelated Unicode file names (%#)",
    async (name) => {
      expect(isSafeOcrFileName(name)).toBe(false);
      await expect(validateOcrImageFile(createPngFile(8, name))).rejects.toMatchObject({
        reason: "FILE_NAME_INVALID",
      });
    },
  );

  it.each(FORMATS)(
    "accepts matching $mime signature and preserves file name",
    async ({ mime, bytes, name }) => {
      const result = await validateOcrImageFile(
        new File([bytes], name, { type: mime }),
      );
      expect(result.fileName).toBe(name);
      expect(result.mimeType).toBe(mime);
      expect(result.bytes).toEqual(bytes);
    },
  );

  it.each(FORMATS)("accepts exactly 4MiB for $mime", async ({ mime, bytes, name }) => {
    const padded = new Uint8Array(OCR_INPUT_LIMITS.maxInlineImageBytes);
    padded.set(bytes);
    await expect(
      validateOcrImageFile(new File([padded], name, { type: mime })),
    ).resolves.toMatchObject({ mimeType: mime });
  });

  it.each(FORMATS)(
    "rejects 4MiB+1 for $mime before reading bytes",
    async ({ mime, name }) => {
      let reads = 0;
      const file = {
        name,
        type: mime,
        size: OCR_INPUT_LIMITS.maxInlineImageBytes + 1,
        arrayBuffer: async () => {
          reads += 1;
          return new ArrayBuffer(0);
        },
      } as File;
      await expect(validateOcrImageFile(file)).rejects.toMatchObject({
        code: "ADMIN_OCR_INPUT_INVALID",
        reason: "INLINE_PAYLOAD_TOO_LARGE",
      });
      expect(reads).toBe(0);
    },
  );

  it.each(FORMATS)(
    "rejects truncated $mime magic bytes",
    async ({ mime, bytes, name }) => {
      await expect(
        validateOcrImageFile(new File([bytes.slice(0, -1)], name, { type: mime })),
      ).rejects.toMatchObject({ reason: "IMAGE_SIGNATURE_INVALID" });
    },
  );

  it.each(FORMATS)("rejects forged MIME for $mime", async ({ mime, bytes, name }) => {
    const claimed = mime === "image/png" ? "image/jpeg" : "image/png";
    await expect(
      validateOcrImageFile(new File([bytes], name, { type: claimed })),
    ).rejects.toMatchObject({ reason: "IMAGE_SIGNATURE_INVALID" });
  });

  it.each(["", "image/gif", "image/svg+xml", "application/octet-stream"])(
    "rejects unsupported MIME %j",
    async (type) => {
      await expect(
        validateOcrImageFile(new File([PNG_SIGNATURE], "arrival.png", { type })),
      ).rejects.toMatchObject({ reason: "FILE_TYPE_INVALID" });
    },
  );

  it.each([
    "../arrival.png",
    "a/b.png",
    "a\\b.png",
    " arrival.png",
    "arrival.png ",
    "a\u0000.png",
    "a".repeat(121),
  ])("rejects unsafe file name %j", async (name) => {
    await expect(validateOcrImageFile(createPngFile(8, name))).rejects.toMatchObject({
      reason: "FILE_NAME_INVALID",
    });
  });

  it("accepts exactly 120 file-name characters without trimming", async () => {
    const name = `${"가".repeat(116)}.png`;
    await expect(validateOcrImageFile(createPngFile(8, name))).resolves.toMatchObject({
      fileName: name,
    });
  });

  it("rejects empty, unreadable, and inconsistent size claims safely", async () => {
    await expect(
      validateOcrImageFile(new File([], "arrival.png", { type: "image/png" })),
    ).rejects.toMatchObject({ reason: "FILE_READ_FAILED" });
    const file = Object.assign(createPngFile(8), {
      arrayBuffer: async () => {
        throw new Error("private input detail");
      },
    });
    await expect(validateOcrImageFile(file)).rejects.toMatchObject({
      message: "ADMIN_OCR_INPUT_INVALID:FILE_READ_FAILED",
    });
    const inconsistentFile = createPngFile(8);
    Object.defineProperty(inconsistentFile, "size", { value: 9 });
    await expect(validateOcrImageFile(inconsistentFile)).rejects.toMatchObject({
      reason: "IMAGE_SIGNATURE_INVALID",
    });
  });
});

describe("OCR input messages", () => {
  const row = { sourceText: "", productName: "", brand: "", option: "", quantity: "x" };

  it("keeps Korean by default and returns English on request", () => {
    const error = new AdminOcrInputError("FILE_TYPE_INVALID");
    expect(getOcrInputErrorMessage(error)).toBe(
      "OCR은 PNG, JPEG, WEBP 파일만 받을 수 있습니다.",
    );
    expect(getOcrInputErrorMessage(error, "en")).toBe(
      "OCR accepts only PNG, JPEG and WEBP files.",
    );
    expect(getOcrReviewRowValidationMessage([row])).toBe(
      "1번째 수량은 비우거나 0~999,999,999 정수로 입력해 주세요.",
    );
    expect(getOcrReviewRowValidationMessage([row], "en")).toBe(
      "Leave row 1 quantity empty or enter a whole number from 0 to 999,999,999.",
    );
    expect(getOcrInputErrorMessage(new Error("x"), "en")).toBeUndefined();
  });
});
