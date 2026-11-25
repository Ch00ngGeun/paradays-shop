// 역할: tests/**/*.test.ts Vitest 단위 테스트를 node 환경과 @ 경로 별칭으로 실행하도록 설정합니다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 일부 테스트가 AWS client를 만드는 Lambda 모듈을 불러오므로 인스턴스 메타데이터 조회를 막습니다.
    env: { AWS_EC2_METADATA_DISABLED: "true" },
  },
});
