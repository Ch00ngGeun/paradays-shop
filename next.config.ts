// 역할: 정적 Next.js 스토어프론트 빌드와 로컬 이미지 동작을 설정합니다.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 개발 인디케이터 숨김
  devIndicators: false,
  // `out/` 정적 export
  output: "export",
  allowedDevOrigins: ["127.0.0.1"],
  // 정적 호스팅용 이미지 최적화 비활성
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
