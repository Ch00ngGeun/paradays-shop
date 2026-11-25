import type { Locale } from "@/types/store";
import { AdminApiRequestError } from "./admin-api-client";
import { AdminOcrDemoConnectionError } from "./admin-api-client-errors";
import {
  isRemoteOcrDemoMode,
  readLocalOcrApiBaseUrl,
} from "./admin-api-client-environment";

export const OCR_REGION_FAILURE_MESSAGES: Record<
  string,
  Readonly<Record<Locale, string>>
> = {
  "region-image-mismatch": {
    ko: "이미지 크기와 원본 OCR 좌표가 맞지 않습니다. 같은 이미지로 다시 인식해 주세요.",
    en: "The image size does not match the original OCR coordinates. Run recognition again with the same image.",
  },
  "missing-geometry": {
    ko: "원본 OCR의 위치 정보가 부족합니다. 더 선명한 이미지로 다시 인식하거나 직접 입력해 주세요.",
    en: "The original OCR is missing position data. Run recognition again with a sharper image or enter it manually.",
  },
  "region-quantity-invalid": {
    ko: "수량 영역에 정수 이외의 글자 또는 여러 값이 있습니다. 가격·상태 문구를 제외하고 실제 수량을 다시 지정해 주세요.",
    en: "The quantity area has non-integer text or several values. Leave out price and status text and set the actual quantity area again.",
  },
  "region-row-spacing-uncertain": {
    ko: "상품 간격을 확정하지 못했습니다. 두 번째 상품 위치와 표 끝을 다시 확인해 주세요.",
    en: "Could not determine the spacing between products. Check the second product position and the table end again.",
  },
  "region-boundary-uncertain": {
    ko: "글자가 영역 경계에 걸려 있습니다. 겹치지 않도록 글자 전체를 포함해 다시 지정해 주세요.",
    en: "Text crosses the area boundary. Set the area again so it includes the whole text without overlap.",
  },
  "region-second-row-required": {
    ko: "수량 영역이 없으면 두 번째 상품 위치로 반복 간격을 지정해 주세요.",
    en: "Without a quantity area, set the repeat spacing with the second product position.",
  },
  "region-footer-uncertain": {
    ko: "표에 합계나 안내 문구가 포함될 수 있습니다. 마지막 상품 바로 아래로 표 끝을 다시 지정해 주세요.",
    en: "The table may include totals or notes. Set the table end right below the last product.",
  },
  "quantity-column-conflict": {
    ko: "금액·번호·상태 영역은 수량으로 사용할 수 없습니다. 실제 수량 영역을 선택해 주세요.",
    en: "Price, number or status areas cannot be used as quantity. Select the actual quantity area.",
  },
};

/** OCR API 실패를 운영자가 조치할 수 있는 문구로 바꿉니다. */
export function getOcrRequestErrorMessage(
  error: unknown,
  locale: Locale = "ko",
): string | undefined {
  const t = (ko: string, en: string) => (locale === "ko" ? ko : en);
  if (error instanceof AdminOcrDemoConnectionError)
    return error.timedOut
      ? t(
          "PC OCR 임시 연결의 2분 대기 시간이 지났습니다. PC와 HTTPS 중계 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "The temporary PC OCR connection passed its 2-minute wait. Check the PC and the HTTPS relay, then try again. The current review is kept.",
        )
      : t(
          "PC OCR 임시 연결에 접속하지 못했습니다. 담당 PC나 HTTPS 중계가 꺼져 있거나 주소가 만료되었을 수 있습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "Could not reach the temporary PC OCR connection. The PC or HTTPS relay may be off, or the address may have expired. Check the connection, then try again. The current review is kept.",
        );

  if (
    !(error instanceof AdminApiRequestError) ||
    !error.endpoint.startsWith("admin/ocr/")
  ) {
    return undefined;
  }

  if (error.status === 401 || error.responseCode === "ADMIN_AUTH_REQUIRED") {
    return t(
      "관리자 로그인이 만료되었습니다. 다시 로그인한 뒤 OCR을 실행해 주세요.",
      "Your admin sign-in has expired. Sign in again, then run OCR.",
    );
  }

  if (error.responseCode === "LOCAL_OCR_ORIGIN_REQUIRED")
    return isRemoteOcrDemoMode()
      ? t(
          "PC OCR 임시 연결이 이 화면을 허용하지 않습니다. 담당자가 Firebase 접속 허용 설정을 확인해야 합니다.",
          "The temporary PC OCR connection does not allow this screen. The operator needs to check the Firebase allowed-origin setting.",
        )
      : t(
          "로컬 OCR은 전용 개발 화면 http://localhost:3138/admin에서 실행해 주세요.",
          "Run local OCR from the dedicated development screen at http://localhost:3138/admin.",
        );

  if (error.status === 403 || error.responseCode === "ADMIN_ROLE_REQUIRED") {
    if (readLocalOcrApiBaseUrl() || isRemoteOcrDemoMode()) {
      return t(
        "PC OCR도 서명된 Cognito access token의 admin 그룹 권한이 필요합니다. 그룹 권한이 없으면 사용할 수 없습니다. 다시 로그인해 주세요.",
        "PC OCR also needs the admin group in a signed Cognito access token. It cannot be used without that group. Sign in again.",
      );
    }
    return t(
      "OCR은 admin 그룹 권한이 필요합니다. Cognito admin 그룹을 확인해 주세요.",
      "OCR needs the admin group. Check the Cognito admin group.",
    );
  }

  if (
    error.responseCode === "LOCAL_OCR_LIMIT_REACHED" ||
    error.responseCode === "OCR_PROVIDER_BUSY"
  )
    return isRemoteOcrDemoMode()
      ? t(
          "PC OCR이 처리 중이거나 임시 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "PC OCR is busy or has reached its temporary usage limit. Try again shortly. The current review is kept.",
        )
      : t(
          "로컬 OCR이 처리 중이거나 임시 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
          "Local OCR is busy or has reached its temporary usage limit. Try again shortly.",
        );
  if (error.responseCode === "LOCAL_OCR_BODY_TIMEOUT")
    return t(
      "PC OCR 이미지 전송 시간이 초과되었습니다. 네트워크 상태를 확인하거나 더 작은 이미지로 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
      "Sending the image to PC OCR timed out. Check the network or try again with a smaller image. The current review is kept.",
    );
  if (isRemoteOcrDemoMode() && error.status >= 500)
    return t(
      "PC OCR 임시 처리에 실패했거나 대기 시간이 지났습니다. 담당 PC와 HTTPS 중계 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
      "Temporary PC OCR processing failed or timed out. Check the PC and the HTTPS relay, then try again. The current review is kept.",
    );
  if (readLocalOcrApiBaseUrl() && error.status >= 500)
    return t(
      "로컬 PaddleOCR 처리에 실패했습니다. 로컬 서버의 실행 상태와 이미지 크기를 확인해 주세요.",
      "Local PaddleOCR processing failed. Check that the local server is running and the image size.",
    );

  if (error.responseCode === "OCR_IMAGE_INVALID") {
    return t(
      "서버가 이미지 형식을 거절했습니다. PNG·JPEG·WEBP이고 파일 내용이 확장자와 일치하는지 확인해 주세요.",
      "The server rejected the image format. Check that it is PNG, JPEG or WEBP and that the content matches the extension.",
    );
  }

  if (error.responseCode === "OCR_IMAGE_TOO_LARGE") {
    return t(
      "현재 직접 OCR은 4MiB 이하만 지원합니다. 더 작은 파일로 다시 선택해 주세요.",
      "Direct OCR currently supports files up to 4MiB. Choose a smaller file.",
    );
  }

  if (
    error.responseCode === "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE" ||
    error.responseCode === "OCR_JOB_CONFIGURATION_UNAVAILABLE"
  ) {
    return t(
      "PaddleOCR 서비스 설정이 비어 있습니다. AWS Secrets Manager paradays-dev/paddle-ocr에 baseUrl·sharedSecret을 넣은 뒤 다시 시도해 주세요.",
      "The PaddleOCR service settings are empty. Add baseUrl and sharedSecret to AWS Secrets Manager paradays-dev/paddle-ocr, then try again.",
    );
  }

  if (error.responseCode === "OCR_PROVIDER_REQUEST_FAILED") {
    return t(
      "관리자 API는 연결됐지만 PaddleOCR 서비스 호출에 실패했습니다. baseUrl·네트워크·공유 비밀값을 확인해 주세요.",
      "The admin API is connected, but calling the PaddleOCR service failed. Check baseUrl, the network and the shared secret.",
    );
  }

  if (error.responseCode === "OCR_PROVIDER_RESPONSE_INVALID") {
    return t(
      "PaddleOCR 응답 형식이 올바르지 않습니다. /ocr 응답의 rec_texts 필드를 확인해 주세요.",
      "The PaddleOCR response format is invalid. Check the rec_texts field of the /ocr response.",
    );
  }

  if (error.responseCode === "OCR_JOB_STORAGE_UNAVAILABLE") {
    return t(
      "OCR 검토 저장소(DynamoDB)에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      "Could not reach the OCR review store (DynamoDB). Try again shortly.",
    );
  }

  if (error.responseCode === "OCR_JOB_RAW_TEXT_INVALID") {
    return t(
      "원문은 100,000자 이하로 입력하고 잘못된 제어 문자를 제거해 주세요.",
      "Keep the source text to 100,000 characters and remove invalid control characters.",
    );
  }

  if (error.responseCode === "OCR_JOB_TOO_LARGE") {
    return t(
      "OCR 검토본이 저장 가능한 크기를 초과했습니다. 원문이나 검토 행을 줄인 뒤 다시 저장해 주세요.",
      "The OCR review is larger than can be saved. Shorten the source text or review rows, then save again.",
    );
  }

  if (
    ["OCR_JOB_MAPPING_INVALID", "OCR_JOB_MAPPING_UNUSABLE"].includes(
      error.responseCode ?? "",
    )
  )
    return error.mappingReason &&
      Object.hasOwn(OCR_REGION_FAILURE_MESSAGES, error.mappingReason)
      ? OCR_REGION_FAILURE_MESSAGES[error.mappingReason][locale] +
          t(" 현재 검토본은 유지됩니다.", " The current review is kept.")
      : t(
          "열 또는 영역 지정으로 상품 행을 확정하지 못했습니다. 선택 영역과 수량·반복 간격을 다시 확인해 주세요. 현재 검토본은 유지됩니다.",
          "Could not determine product rows from the columns or areas. Check the selected areas, quantity and repeat spacing again. The current review is kept.",
        );
  if (error.responseCode === "OCR_JOB_SOURCE_ROWS_UNAVAILABLE")
    return t(
      "이전 검토본에 재분류할 원본 좌표가 없습니다. 이미지를 다시 인식한 뒤 열을 지정해 주세요.",
      "The earlier review has no original coordinates to reclassify. Run recognition on the image again, then set the columns.",
    );

  if (error.status >= 500) {
    return t(
      "OCR 서버 처리에 실패했습니다. PaddleOCR secret 설정과 관리자 API 로그를 확인해 주세요.",
      "OCR server processing failed. Check the PaddleOCR secret settings and the admin API logs.",
    );
  }

  return t(
    "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.",
    "The OCR request failed. Check the image format and the admin API and PaddleOCR connections.",
  );
}
