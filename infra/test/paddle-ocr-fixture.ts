// 역할: PaddleOCR 테스트용 PNG 서명 byte·업로드 body·정규 provider 응답·테스트 자격증명을 만드는 fixture임.

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

// Lambda는 가벼운 서명만 확인하고, header 크기·픽셀 검증은 Python이 맡음.
// 이 fixture가 실제 이미지로 디코딩된다고 가정하지 말 것.
