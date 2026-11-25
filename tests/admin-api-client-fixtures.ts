// 역할: 관리자 API 클라이언트 단위 검사의 API 설정·클라이언트 생성·OCR 검토 행 저장 도우미를 제공함.
import { vi } from "vitest";
import { createAdminApiClient } from "@/lib/commerce/admin-api-client";
import { getCheckoutApiConfig } from "@/lib/commerce/checkout-api-client";
import type { AdminOcrReviewRow } from "@/lib/admin-ui/types";

export const apiConfig = getCheckoutApiConfig({
  NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.example.com/prod/",
});

export function createClient(fetchImplementation: typeof fetch) {
  const getAccessToken = vi.fn(() => "  cognito-admin-access-token  ");

  return {
    client: createAdminApiClient({
      config: apiConfig,
      authorizationTokenProvider: { getAccessToken },
      fetchImplementation,
    }),
    getAccessToken,
  };
}

export const REVIEW_ROW: AdminOcrReviewRow = {
  id: "manual_1",
  sourceText: "",
  productName: "Manual product",
  brand: "",
  option: "",
  quantity: "2",
  confidence: 0.2,
  box: [
    [1, 2],
    [3, 4],
  ],
};

export function saveClient(rawText = "Server canonical text") {
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        job: {
          jobId: "ocr-job-1",
          version: 7,
          rawText,
          rows: [REVIEW_ROW],
        },
      }),
      { status: 200 },
    ),
  );
  return { ...createClient(fetchImplementation), fetchImplementation };
}
