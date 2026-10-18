# PARADAYS AWS CDK 인프라

`infra/`는 정적 Next.js 스토어프론트와 분리한 AWS 회원·주문·Toss Payments 백엔드임. `npm run synth`는 CloudFormation 템플릿만 만들며 AWS 리소스를 생성하지 않음. 아래 항목은 코드와 합성 결과의 구현 범위이며, 현재 AWS 계정에는 아직 배포하지 않았음.

## 구현 범위

- Cognito User Pool, 이메일 가입·인증, `admin`·`support` group, custom Managed Login domain 선택 구성 코드
- secret 없는 public web app client, Authorization Code + PKCE, Cognito Managed Login domain
- DynamoDB `profile`, `order`, `payment-event` 테이블, 주문 조회 GSI, PITR, AWS 관리형 암호화
- API Gateway HTTP API, Cognito JWT authorizer, 환경별 CORS allowlist
- 회원 프로필 조회·수정, 내 주문 목록·상세 조회
- 서버 카탈로그 가격·사이즈 재계산, 멱등 주문 생성, `PENDING_PAYMENT` 주문 저장
- Toss Payments V2 결제창 redirect 뒤의 서버 승인 API와 일반 결제 webhook 재조회 처리
- `admin` group 전용 전체 환불·상품·브랜드·회원·쿠폰·캠페인·OCR 검토 API
- 발행/초안 분리 카탈로그, 브랜드·쿠폰·캠페인·OCR 검토 DynamoDB 테이블과 PaddleOCR relay용 credentials secret (PaddleOCR service 자체는 별도 운영)
- Toss server secret 보관용 Secrets Manager secret과 CloudFormation outputs

브라우저, Lambda, DynamoDB, CloudWatch 로그는 카드번호·CVC·결제 비밀번호를 받거나 저장하지 않음. 결제수단 정보는 Toss 결제창만 처리함.

## 아직 실행하지 않은 항목

- 실제 AWS 리소스 생성·배포 안 했음.
- Cognito Managed Login domain의 고유 prefix 확인, custom domain·ACM 인증서·DNS alias 연결, 실제 로그인/회원가입 테스트 안 했음.
- PaddleOCR service 자체는 이 stack이 생성하지 않음. Lambda에서 접근 가능한 private endpoint와 required shared secret을 준비·Secrets Manager에 주입하거나 실제 OCR 요청을 실행하지 않았음.
- email/SMS/push 발송 공급자·발신자 심사·수신 동의 검증이 없어 외부 메시지를 발송하지 않음.
- Toss Payments client key·server secret 미입력 상태임.
- 실제 결제 인증·승인·환불·webhook 수신 테스트 안 했음.

사업자 등록·PG 심사·키 발급 뒤에만 `dev` 환경에서 테스트 결제를 진행하면 됨.

## 결제 흐름

```text
1. 로그인 회원 → POST /checkout/sessions
2. Checkout Lambda → 서버 카탈로그로 금액·사이즈 재검증 → PENDING_PAYMENT 주문 저장
3. Browser → Toss V2 SDK requestPayment(client key)
4. Toss success redirect → /cart?payment=success
5. Browser → POST /payments/confirm (paymentKey, orderId, redirect return token)
6. Confirm Lambda → 저장 주문 금액과 대조 → Toss server secret으로 승인 → PAID 기록
7. PAYMENT_STATUS_CHANGED webhook → paymentKey로 Toss API 재조회 → 보조 상태 동기화
```

`/payments/confirm`은 Cognito bearer token 대신 주문별 반환 토큰을 사용함. Toss redirect는 전체 페이지 이동이라 브라우저 메모리 token이 사라질 수 있기 때문임. 반환 토큰은 서버 비밀키로 도출하고, DB에는 해시만 저장하며 30분 후 만료됨. 서버는 return URL의 `amount`를 신뢰하지 않고 저장된 주문 금액만 Toss 승인 API에 전달함.

일반 결제 `PAYMENT_STATUS_CHANGED` webhook에는 서명 헤더가 없으므로, handler는 webhook body의 `paymentKey`로 Toss Core API를 재조회해 `orderId`·금액·상태를 다시 검증함. Toss의 최신 안내 기준임.

## API 경로

| 경로                                                                 | 인증                              | 기능                                       |
| -------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ |
| `GET/PATCH /me`                                                      | Cognito JWT                       | 내 프로필 조회·수정                        |
| `GET /orders`, `GET /orders/{orderId}`                               | Cognito JWT                       | 내 주문 목록·상세 조회                     |
| `POST /checkout/sessions`                                            | Cognito JWT + `X-Idempotency-Key` | 서버 가격 검증·결제 준비 주문 생성         |
| `POST /payments/confirm`                                             | 30분짜리 주문 반환 토큰           | Toss server 승인·주문 상태 확정            |
| `POST /payments/webhook`                                             | Toss API 재조회                   | 결제 상태 보조 동기화·중복 event 처리      |
| `POST /admin/orders/{orderId}/refunds`                               | Cognito JWT + `admin` group       | 전체 환불                                  |
| `GET/POST/PATCH/DELETE /admin/catalog/products…`                     | Cognito JWT + `admin` group       | 상품 초안·발행 관리                        |
| `GET/POST/PATCH/DELETE /admin/brands…`                               | Cognito JWT + `admin` group       | 브랜드 관리                                |
| `GET /admin/members`, `POST/DELETE /admin/members/{username}/groups` | Cognito JWT + `admin` group       | 회원·운영 그룹 관리                        |
| `GET/POST/PATCH/DELETE /admin/coupons…`                              | Cognito JWT + `admin` group       | 쿠폰 규칙·발급 초안 관리                   |
| `GET/POST/PATCH/DELETE /admin/campaigns…`                            | Cognito JWT + `admin` group       | 이메일/SMS/push 캠페인 초안·예약 정보 관리 |
| `POST /admin/ocr/jobs`, `GET/PATCH /admin/ocr/jobs/{jobId}`          | Cognito JWT + `admin` group       | PaddleOCR 인식·수정 검토 결과              |
| `GET /catalog/products`                                              | 공개                              | 발행된 상품의 스토어용 최소 정보           |

쿠폰은 규칙·초안만 저장하며 회원별 발급, 장바구니 할인 적용, 사용량 차감은 아직 구현하지 않음. 캠페인도 초안·예약 정보만 저장하며 실제 email/SMS/push 발송은 수신 동의, 발신자 심사, 발송 공급자 credentials가 확정되기 전에는 실행하지 않음. 회원 API는 Cognito의 최소 회원 속성과 `admin`/`support` 그룹만 다루므로, 그룹 변경 뒤에는 새 access token을 발급받기 위해 다시 로그인해야 함. 현재 로그인한 관리자가 자신의 `admin` 그룹을 해제하려 하면 대상의 immutable Cognito `sub`를 다시 조회해 `409`으로 거절하며, 대상 검증 실패도 fail-closed로 처리함. 재고 예약·부분 취소도 결제 도메인 정책 확정 뒤 별도 계약으로 추가해야 함.

## 설치·검증

```bash
cd /Users/admin/Documents/Codex/2026-09-18/new-chat-2/outputs/paradays-shop/infra
npm install
npm run build
npm run synth
```

`cdk.out/`은 합성 결과라 Git에 올리지 않음. `npm run synth`는 안전한 읽기·생성 검증이며 AWS에 배포하지 않음.

## 배포 전 필수 구성

`cdk.json`의 기본 `managedLoginDomainPrefix`는 배포 전 교체해야 하는 placeholder임. 배포 전 리전 전체에서 고유한 lowercase prefix로 바꿔야 하며, `synth`만으로 사용 가능 여부나 실제 Cognito domain은 확정되지 않음. 실제 도메인이 정해지면 아래 context도 변경해야 함.

- `allowedOrigins`
- `callbackUrls`
- `logoutUrls`

```bash
npx cdk synth \
  -c stage=staging \
  -c managedLoginDomainPrefix=your-unique-staging-login-domain
```

소유한 운영 도메인으로 Cognito custom domain을 쓸 경우에는 **us-east-1** public ACM 인증서 ARN과 DNS 권한이 필수임. 두 context를 함께 넘겨야 하며, `auth.example.com` 같은 placeholder를 실제 소유 확인 전 배포하지 않음.

CDK entrypoint는 custom domain hostname 형식, 두 context의 동시 설정, `us-east-1` ACM certificate ARN 형식을 사전에 검사함. 이는 입력 검증일 뿐 인증서 public 상태·도메인 소유권·DNS alias 연결을 확인하거나 생성하지는 않음.

```bash
npx cdk synth \
  -c stage=production \
  -c managedLoginDomainPrefix=paradays-production-login \
  -c cognitoCustomDomain=auth.example.com \
  -c cognitoCustomDomainCertificateArn=arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/CERTIFICATE_ID
```

실제 배포는 AWS 계정, 리전, Cognito redirect URL, 공개 도메인, 개인정보·환불 정책 승인이 끝난 뒤에만 실행해야 함. custom domain을 선택했다면 **us-east-1** public ACM 인증서와 DNS alias까지 준비한 뒤 deploy 결과를 확인해야 함.

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-2
npm run deploy
```

## 비밀값·공개 환경값

Toss server secret은 `cdk.json`, TypeScript 코드, root `.env`, 프런트 번들에 넣지 않음. Stack 배포 후 `TossPaymentsSecretArn` output에 해당하는 Secrets Manager secret JSON에 `secretKey`만 넣음.

```json
{ "secretKey": "live_sk_..." }
```

프런트 `.env`는 root [`.env.example`](../.env.example)처럼 공개값만 둠.

- `NEXT_PUBLIC_TOSS_CLIENT_KEY`: Toss V2 결제창 client key
- `NEXT_PUBLIC_COMMERCE_API_BASE_URL`: API Gateway endpoint
- `NEXT_PUBLIC_COGNITO_*`: Hosted UI public client 설정

Toss API의 Basic 인증은 `secretKey:`처럼 끝에 colon을 포함해 base64 인코딩함. 코드에 이미 반영되어 있음. Secrets Manager의 실제 값은 채팅, Git, 스크린샷, 브라우저 환경변수에 공유하면 안 됨.

PaddleOCR service 자체는 이 stack이 배포하지 않음. 운영자가 Lambda에서 접근 가능한 private service를 별도로 준비한 뒤, endpoint와 shared secret을 `PaddleOcrSecretArn` output의 Secrets Manager JSON으로만 설정함. 현재 OCR handler는 `baseUrl`과 비어 있지 않은 `sharedSecret`을 모두 요구하고, secret은 private `/ocr` 호출의 Bearer credential으로만 사용함. CDK가 만든 초기 secret은 연결 가능한 OCR 설정이 아니므로 private service를 준비한 뒤 운영자가 교체해야 함. 브라우저와 `NEXT_PUBLIC_*`에는 OCR URL·token을 넣지 않음.

```json
{ "baseUrl": "https://private-ocr.example.com", "sharedSecret": "replace-me" }
```

상세한 Cognito admin group 부여, OCR file limit·수정·발행 흐름은 [`docs/admin-operations.md`](../docs/admin-operations.md)를 참조함.

## 운영 전 확인 목록

1. `dev → staging → production` 환경과 secret을 분리함.
2. 서버 카탈로그(`lambda/catalog.ts`)를 실제 CMS·재고 서비스로 교체하고, 관리자 발행 카탈로그와 결제 가격 검증을 같은 소스로 전환함.
3. `PAYMENT_STATUS_CHANGED` webhook URL을 Toss 개발자센터에 HTTPS로 등록함.
4. 테스트 key로 성공·실패·중복 클릭·금액 변조·승인 재시도·webhook 중복을 확인함.
5. Cognito callback/logout URL과 API CORS origin을 운영 도메인으로 제한함.
6. 상품 이미지 업로드 저장소/CDN을 연결한 뒤 관리자 화면의 브라우저 미리보기 이미지와 실제 공개 이미지를 분리함.
7. OCR endpoint·shared secret, 마케팅 수신 동의와 각 발송 공급자를 확정하고 별도 발송 검증을 수행함.
8. 주문 보존·탈퇴·환불·배송·개인정보 정책을 법무 승인본으로 교체함.
