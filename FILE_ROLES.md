<!-- 역할: 주석을 넣을 수 없거나 바이트 그대로 보존해야 하는 JSON·lock·이미지·자동 생성 파일의 역할과 보존 hash를 기록함. -->

# 주석 불가·보존 파일 역할

JSON·`.firebaserc`·lock·이미지·자동 생성 파일은 주석을 넣으면 형식이 깨지거나 파일 내용이 바뀌므로 역할을 이 문서에 모아 기록함. 아래 hash는 기준 commit `a5970db`의 SHA-256이며, 주석 정리 작업에서 이 파일들은 바이트 그대로 보존함. 이후 의존성 갱신·설정 변경·이미지 교체로 파일이 바뀌면 이 표도 함께 갱신함.

## JSON 설정·데이터

| 파일                                        | 역할                                                                                                                                                            | SHA-256                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `package.json`                              | 루트 스토어프론트 패키지 정의. Next.js·React·Firebase 의존성과 `dev`·`build`·`lint`·`typecheck`·`format`·`test`(Vitest)·`test:e2e`(Playwright) 스크립트를 정함. | `74855fd6ed538d4ac80146dcda81711861bb5bf4e244a3b6573a7f6d0f7c4c31` |
| `tsconfig.json`                             | 루트 TypeScript 설정. strict·`noEmit`·bundler 해석·Next 플러그인과 `@/*` 경로 별칭을 정하고 `next-env.d.ts`·`.next` 생성 타입을 포함함.                         | `f64298161a902dbf5eff2e649aa8d9392c7f1a4a28b493b8c68a897281d7d45b` |
| `firebase.json`                             | Firebase Hosting(`out` 정적 export, cleanUrls, 끝 슬래시 없음)과 Firestore 규칙 파일(`firestore.rules`) 위치를 지정함.                                          | `61125923ff24168b005fe0eec4bd53c26c8179055f58ae7bf713a7af2de1c9d7` |
| `infra/package.json`                        | AWS CDK 인프라 패키지 정의. AWS SDK·CDK 의존성과 `build`·`test`(node test + tsx)·`synth`·`diff`·`deploy` 스크립트를 정함.                                       | `5cbaf598ea294949bf85c2c30b4a7f6eb4f7142b73557ea7397f052f902eeb3d` |
| `infra/tsconfig.json`                       | 인프라 TypeScript 설정. ES2022·NodeNext·strict로 `bin`·`lib`·`lambda`·`test`를 `dist`로 컴파일함.                                                               | `a92293d2c030ff12ccf910ff88cabc5e4784fec03e44b79b50b56ff5046fa393` |
| `infra/cdk.json`                            | CDK 앱 실행 명령(`tsx bin/paradays-commerce.ts`)과 앱 이름·stage·로그인 도메인 접두어·허용 origin·Cognito callback/logout URL 등 배포 context 값을 정함.        | `cdf6801a53e70e09049176784e26e8bafbc52a943e9dcc3683eb0f5200dd0143` |
| `tests/fixtures/ocr-baseline-provider.json` | OCR provider 응답 기준 fixture. `tests/ocr-table-parser.test.ts`와 `e2e/admin-ocr-region.spec.ts`가 표 파싱·영역 매핑 검증 입력으로 읽음.                       | `a69e2735930b9b5e6278b54fbb6d4eb7144871f61090ab9b55b359654d2ce2fb` |

## JSON 형식 설정·lock

| 파일                      | 역할                                                                                           | SHA-256                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.firebaserc`             | Firebase CLI 기본 프로젝트 별칭(`default`)을 지정하는 JSON 형식 설정임.                        | `3c2eeb2e30611fc37223409f2cf331a13f5ab1457637844c60a1fb850e393e74` |
| `package-lock.json`       | 루트 의존성 설치 버전을 고정하는 npm 자동 생성 lock. `npm ci`로만 설치하며 직접 수정하지 않음. | `79eebc500760ce5d78c06c7b90e6d87aa0098335b469925fda4fa2d4eae9aa42` |
| `infra/package-lock.json` | 인프라 의존성 설치 버전을 고정하는 npm 자동 생성 lock. `infra`에서 `npm ci`로만 설치함.        | `1317e39db3520b614c1919772893928d0751b329e36ba70cde1de97e3164f953` |

## 자동 생성 파일

| 파일            | 역할                                                                                                                                       | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `next-env.d.ts` | Next.js가 자동 생성하는 타입 참조 파일. `next`·이미지 타입 참조와 `.next/types` 경로 타입을 불러오며, 파일 안 안내대로 직접 수정하지 않음. | `1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b` |

## 이미지

| 파일                                    | 역할                                                                                                                                             | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `public/brand/paradays-logo.jpg`        | PARADAYS 로고 원본(996×155). 헤더 로고(`components/logo-placeholder.tsx`)와 캠페인 메일 본문 삽입 로고(`lib/admin-ui/campaign-message.ts`)로 씀. | `13f1bc0bf552ace98a337bccbb1959abc383e8363869f1222f02a5f84790e4fd` |
| `public/images/admin-board-example.png` | 관리자 상품 이미지가 없거나 대체 이미지·로드 실패일 때 보여주는 보드 예시 이미지(`components/admin-product-image.tsx`).                          | `ac9a28da2f36fc0ed69a0526eb82b69b04786df64cc6cf5795e178b4b264777f` |
| `public/images/clay-wheels.webp`        | 기본 카탈로그(`data/products.ts`) Proto Clay 휠 상품 이미지.                                                                                     | `90c0490733039a8ab1d8689bc4502edb86fdfc3bafd6af2c2102559163a0e770` |
| `public/images/dekeyzer-deck.webp`      | 기본 카탈로그 De Keyzer 데크 상품 이미지. 관리자 이미지 e2e(`e2e/admin-navigation-images.spec.ts`)에서도 경로를 참조함.                          | `8703a3b3bf4b7eacc183a7bfd65e02e4150d8efb4711301decfa0d8e5f0fecec` |
| `public/images/imagine-hat-black.jpg`   | 기본 카탈로그 모자 상품 이미지.                                                                                                                  | `8239992fe120a0dad0da04e5d0d6020007fcbbed92c83279fd8613c84a29e8e0` |
| `public/images/odwyer-deck-8-375.webp`  | 기본 카탈로그 O'Dwyer 데크(8.375) 대표 이미지.                                                                                                   | `681f1fecf5086005228f4d3a4c5a8fe93e86027d400bb475b75a8611cd1c0233` |
| `public/images/odwyer-deck-8-5.webp`    | 기본 카탈로그 O'Dwyer 데크(8.5) 이미지.                                                                                                          | `ce22c68986e13b2b47fe7c1451c86b31e3693f32a3c3611caef004c7d9bee9c8` |
| `public/images/plaid-shirt.jpg`         | 기본 카탈로그 체크 셔츠 상품 이미지.                                                                                                             | `bed9c98d4e3ddb9d88fd6236ee9964c63b0ccf96fc2a10aa2e4ac6ba4b6e9a61` |
| `public/images/rizzo-deck.webp`         | 기본 카탈로그 Rizzo 데크 상품 이미지. 발행 상품 캐시 단위 테스트(`tests/published-catalog-cache.test.ts`)에서도 경로를 참조함.                   | `1d48787439f12e86d28a67391d01d31e35379f513f652b266ee7ef8662013a98` |
| `public/images/triangle-sweater.webp`   | 기본 카탈로그 스웨터 상품 이미지이며 체크 셔츠 상품의 추가 이미지로도 씀.                                                                        | `aa3d6cd2c8c4945b13c3751e89fc322e2e358e8163faaef367afdca3d0886b5c` |

## 확인 방법

- hash 확인: `shasum -a 256 <파일>` 결과를 위 표와 비교함.
- 기준과 동일 여부: `git diff --quiet a5970db -- <파일>`이 0으로 끝나면 바이트가 같음.
