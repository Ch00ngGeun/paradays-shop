// 역할: Next.js 접근성, 성능, TypeScript 린트 규칙을 적용합니다.
import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "playwright-report/**",
    "test-results/**",
    "infra/cdk.out/**",
    "infra/dist/**",
  ]),
]);
