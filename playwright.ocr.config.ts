// 역할: 관리자 OCR e2e spec을 복사한 임시 소스·모의 공개 설정의 개발 서버(포트 3137)에서 실제 API 없이 실행합니다.
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const remoteDemo = process.env.PARADAYS_OCR_E2E_REMOTE_DEMO === "true";
const workspace =
  process.env.PARADAYS_OCR_E2E_WORKSPACE ??
  mkdtempSync(join(tmpdir(), "paradays-ocr-e2e-"));
if (!process.env.PARADAYS_OCR_E2E_WORKSPACE) {
  // 명시한 소스 허용 목록만 복사해 .env·infra 자격정보·모델·사용자 빌드 출력을 제외합니다.
  // Next가 설정·타입·AGENTS 파일을 다시 만들더라도 이 복사본 안에서만 만듭니다.
  for (const name of [
    "app",
    "components",
    "contexts",
    "hooks",
    "data",
    "lib",
    "public",
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "next-env.d.ts",
  ]) {
    if (existsSync(join(root, name)))
      cpSync(join(root, name), join(workspace, name), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  // 순수 공유 파서 2파일만 포함함. 서버 설정·인증 파일은 복사하지 않음.
  mkdirSync(join(workspace, "infra", "lambda"), { recursive: true });
  for (const name of ["ocr-table-parser.js", "ocr-table-parser.d.ts"])
    cpSync(
      join(root, "infra", "lambda", name),
      join(workspace, "infra", "lambda", name),
    );
  process.env.PARADAYS_OCR_E2E_WORKSPACE = workspace;
  console.log(`OCR test workspace and artifacts: ${workspace}`);
}

export default defineConfig({
  testDir: join(root, "e2e"),
  testMatch: [
    "admin-ocr-redesign.spec.ts",
    "admin-ocr-region.spec.ts",
    "admin-ocr-remote-demo.spec.ts",
    "admin-ocr-recognition.spec.ts",
    "admin-ocr-inventory-plan.spec.ts",
    "admin-ocr-inventory-writes.spec.ts",
  ],
  outputDir: join(workspace, "test-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3137",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-ocr", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3137",
    cwd: workspace,
    url: "http://127.0.0.1:3137/admin",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      WATCHPACK_POLLING: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_LOCAL_OCR_ENABLED: "false",
      NEXT_PUBLIC_LOCAL_OCR_API_URL: "",
      // 테스트 전용으로 고정한 값이며, 실행 환경의 데모 설정이 섞여 들어오지 않게 합니다.
      NEXT_PUBLIC_OCR_DEMO_ENABLED: remoteDemo ? "true" : "false",
      NEXT_PUBLIC_OCR_DEMO_API_URL: remoteDemo ? "https://ocr-relay.demo.test" : "",
      NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN: remoteDemo
        ? "https://ocr-relay.demo.test"
        : "",
      NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.ocr.test/prod/",
      NEXT_PUBLIC_COGNITO_DOMAIN: "https://auth.ocr.test",
      NEXT_PUBLIC_COGNITO_CLIENT_ID: "ocr-test-public-client",
      NEXT_PUBLIC_COGNITO_REDIRECT_URI: "http://127.0.0.1:3137/auth/callback",
      NEXT_PUBLIC_COGNITO_LOGOUT_URI: "http://127.0.0.1:3137",
      NEXT_PUBLIC_COGNITO_ISSUER: "https://auth.ocr.test",
      NEXT_PUBLIC_COGNITO_SCOPES: "openid email profile paradays-commerce/api",
      NEXT_PUBLIC_FIREBASE_API_KEY: "",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "",
      NEXT_PUBLIC_FIREBASE_APP_ID: "",
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "",
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "",
      NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED: "",
      NEXT_PUBLIC_TOSS_CLIENT_KEY: "",
    },
  },
});
