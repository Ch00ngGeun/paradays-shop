/** Credential-free sales browser tests run only against a temporary source copy. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = dirname(fileURLToPath(import.meta.url));
const workspace =
  process.env.PARADAYS_SALES_E2E_WORKSPACE ??
  mkdtempSync(join(tmpdir(), "paradays-sales-e2e-"));
if (!process.env.PARADAYS_SALES_E2E_WORKSPACE) {
  // Deliberate allowlist excludes .env, credentials, infra configuration and builds.
  // Next may generate config/types/AGENTS only inside this temporary copy.
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
  mkdirSync(join(workspace, "infra", "lambda"), { recursive: true });
  for (const name of [
    "ocr-table-parser.js",
    "ocr-table-parser.d.ts",
    "sales-ledger-domain.ts",
  ])
    cpSync(
      join(root, "infra", "lambda", name),
      join(workspace, "infra", "lambda", name),
    );
  process.env.PARADAYS_SALES_E2E_WORKSPACE = workspace;
  console.log(`Sales test workspace and artifacts: ${workspace}`);
}

export default defineConfig({
  testDir: join(root, "e2e"),
  testMatch: "admin-sales-ledger.spec.ts",
  outputDir: join(workspace, "test-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3139",
    // KST entry/display must not depend on the operator's browser time zone.
    timezoneId: "America/Los_Angeles",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-sales", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3139",
    cwd: workspace,
    url: "http://127.0.0.1:3139/admin",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      WATCHPACK_POLLING: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_LOCAL_OCR_ENABLED: "false",
      NEXT_PUBLIC_LOCAL_OCR_API_URL: "",
      NEXT_PUBLIC_OCR_DEMO_ENABLED: "false",
      NEXT_PUBLIC_OCR_DEMO_API_URL: "",
      NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN: "",
      NEXT_PUBLIC_COMMERCE_API_BASE_URL: "https://api.sales.test/prod/",
      NEXT_PUBLIC_COGNITO_DOMAIN: "https://auth.sales.test",
      NEXT_PUBLIC_COGNITO_CLIENT_ID: "sales-test-public-client",
      NEXT_PUBLIC_COGNITO_REDIRECT_URI: "http://127.0.0.1:3139/auth/callback",
      NEXT_PUBLIC_COGNITO_LOGOUT_URI: "http://127.0.0.1:3139",
      NEXT_PUBLIC_COGNITO_ISSUER: "https://auth.sales.test",
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
