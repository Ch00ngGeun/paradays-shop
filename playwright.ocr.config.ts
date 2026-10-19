/** Isolated OCR browser tests: copied source, mock public settings, no live API. */
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
  // Explicit source allowlist excludes .env, infra credentials, models, and user
  // build artifacts. Next may regenerate config/types/AGENTS only in this copy.
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
  testMatch: "admin-ocr.spec.ts",
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
      // Deliberate test-only pin; ambient demo settings must never enter a run.
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
