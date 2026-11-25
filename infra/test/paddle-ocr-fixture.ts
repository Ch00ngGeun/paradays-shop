// 역할: OCR inline image parser가 대형 base64에서도 정규식 RangeError 없이 경계를 지키는지 확인합니다.

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function createPngBytes(byteLength: number) {
  const bytes = Buffer.alloc(byteLength);
  PNG_SIGNATURE.copy(bytes);

  return bytes;
}

export function createUpload(imageBytes: Buffer, fileName = "arrival.png") {
  return {
    fileName,
    mimeType: "image/png",
    imageBase64: imageBytes.toString("base64"),
  };
}

export function createCanonicalProviderEnvelope(prunedResult: unknown) {
  return {
    result: {
      ocrResults: [{ prunedResult }],
    },
  };
}
export const TEST_CREDENTIALS = {
  baseUrl: "https://ocr.example.test/provider",
  sharedSecret: "test-only-secret",
};

// Lambda only checks the lightweight signature; Python performs bounded header
// dimensions/pixel validation. Do not claim these fixtures decode as images.
