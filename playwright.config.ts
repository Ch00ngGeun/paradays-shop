// 역할: 스토어프론트 내비게이션과 모달 동작에 대한 브라우저 수준 회귀 테스트를 정의합니다.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3010",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "WATCHPACK_POLLING=true npm run dev -- --webpack --port 3010",
    env: {
      ...process.env,
      // 브라우저 회귀 테스트에서 실제 Cognito/Firebase 인증 발송을 절대 시작하지 않습니다.
      NEXT_PUBLIC_COGNITO_DOMAIN: "",
      NEXT_PUBLIC_COGNITO_CLIENT_ID: "",
      NEXT_PUBLIC_COGNITO_REDIRECT_URI: "",
      NEXT_PUBLIC_COGNITO_LOGOUT_URI: "",
      NEXT_PUBLIC_COGNITO_SCOPES: "",
      NEXT_PUBLIC_COGNITO_ISSUER: "",
      NEXT_PUBLIC_FIREBASE_API_KEY: "",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "",
      NEXT_PUBLIC_FIREBASE_APP_ID: "",
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "",
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "",
      NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED: "",
    },
    url: "http://127.0.0.1:3010",
    // 기존 개발 서버의 환경 변수를 재사용하면 실제 provider 설정을 물고 갈 수 있습니다.
    // 이 스위트는 항상 위의 비활성 환경으로 새 서버를 시작합니다.
    reuseExistingServer: false,
  },
});
