// 역할: 관리자 API 클라이언트가 던지는 응답 계약 위반·OCR 데모 연결·상품 이미지 입력 오류 클래스를 정의합니다.
/** 관리자 API 응답이 기대한 public contract를 만족하지 않을 때 안전하게 중단합니다. */
export class AdminApiResponseError extends Error {
  readonly code = "ADMIN_API_RESPONSE_INVALID";

  constructor() {
    super("ADMIN_API_RESPONSE_INVALID");
    this.name = "AdminApiResponseError";
  }
}

/** 임시 PC OCR 연결 오류에는 주소·토큰·서버 응답 내용을 포함하지 않습니다. */
export class AdminOcrDemoConnectionError extends Error {
  readonly code = "OCR_DEMO_CONNECTION_FAILED";

  constructor(readonly timedOut = false) {
    super("OCR_DEMO_CONNECTION_FAILED");
    this.name = "AdminOcrDemoConnectionError";
  }
}

/** 상품 이미지 업로드 입력이 거절되었을 때 UI에 전달합니다. */
export class AdminProductImageInputError extends Error {
  readonly code = "ADMIN_PRODUCT_IMAGE_INPUT_INVALID";

  constructor(message = "ADMIN_PRODUCT_IMAGE_INPUT_INVALID") {
    super(message);
    this.name = "AdminProductImageInputError";
  }
}
