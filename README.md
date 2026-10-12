# PARADAYS storefront prototype

Next.js App Router + TypeScript strict 기반 스케이트보드샵 구현물임. 정적 스토어프론트와 AWS CDK 기반 Cognito·주문·Toss Payments 백엔드 소스까지 구현되어 있음. AWS 배포, Toss 키 입력, 실제 승인·웹훅 호출은 아직 실행하지 않았음.

## Run locally

```bash
npm install
npm run dev
```

파일 감시 한도가 낮은 환경에서 `EMFILE`이 발생하면 아래 방식으로 개발 서버 실행하면 됨.

```bash
WATCHPACK_POLLING=true npm run dev -- --webpack --port 3010
```

품질 확인 명령:

```bash
npm run lint
npm run typecheck
npm run format:check
npm run test
npm run build
```

Playwright 브라우저가 설치되지 않은 환경에서는 한 번만 아래 명령 실행 후 E2E 테스트 실행하면 됨.

```bash
npx playwright install chromium
npm run test:e2e
```

## Commerce implementation status

- 승인된 로고 수령 후 `public/brand/paradays-logo-placeholder.svg`를 실제 로고 파일로 교체하고 파일명·`components/logo-placeholder.tsx` 경로를 함께 확인하면 됨.
- 상품 이미지는 `public/images/product-placeholder.svg` 대신 CMS 또는 승인된 제품 촬영본으로 교체하면 됨.
- `infra/`에는 Cognito Hosted UI + PKCE, 회원 프로필·주문 API, 서버 가격 검증, Toss V2 승인·웹훅 재조회, 관리자 전체 환불 API가 포함됨.
- 실제 결제 전에는 AWS 환경 배포, Toss client/server key 등록, callback/CORS 도메인 제한, 테스트 승인·웹훅 검증이 필요함. 상세 절차는 [`infra/README.md`](./infra/README.md) 참고하면 됨.
