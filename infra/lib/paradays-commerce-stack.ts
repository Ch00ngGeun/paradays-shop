/**
 * 역할: PARADAYS 회원·주문·Toss Payments 연동 기반 리소스를 CDK로 정의함.
 * 기능: Cognito, DynamoDB, HTTP API, 상거래 Lambda, Secrets Manager와 출력값을 생성함.
 */

import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { toPascalCase, createCommerceFunction } from "./paradays-commerce-functions.js";
import {
  privateOcrIsEnabled,
  createPrivateOcrService,
} from "./paradays-commerce-private-ocr.js";

/** 환경마다 달라지는 공개 구성만 Stack 밖에서 주입받음. */
export interface CommerceStackProps extends StackProps {
  readonly applicationName: string;
  readonly stage: string;
  readonly managedLoginDomainPrefix: string;
  readonly allowedOrigins: string[];
  readonly callbackUrls: string[];
  readonly logoutUrls: string[];
  /** 소유가 검증된 운영 도메인이 있을 때만 Cognito custom domain을 연결합니다. */
  readonly customCognitoDomain?: Readonly<{
    domainName: string;
    certificateArn: string;
  }>;
}

/**
 * 회원·주문·결제 API의 AWS 인프라를 구성함.
 * Toss Payments의 실제 server secret은 이 Stack이나 Lambda 환경 변수에 넣지 않음.
 */
export class CommerceStack extends Stack {
  public constructor(scope: Construct, id: string, props: CommerceStackProps) {
    super(scope, id, props);

    const namePrefix = `${props.applicationName}-${props.stage}`;
    const isProduction = props.stage === "production";
    const dataRemovalPolicy = isProduction
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;

    /** Cognito는 자격증명과 MFA·비밀번호 정책만 담당함. */
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${namePrefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });

    /** Firebase SMS 본인인증 토큰이 있으면 PreSignUp에서 자동 확인. */
    const preSignUpFunction = createCommerceFunction(this, "CognitoPreSignUpFunction", {
      entryFileName: "cognito-presignup-handler.ts",
      environment: {
        FIREBASE_WEB_API_KEY: process.env.FIREBASE_WEB_API_KEY ?? "",
      },
    });
    userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUpFunction);

    /** 운영 API의 역할 분리를 위해 Cognito group을 미리 정의함. */
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      groupName: "admin",
      userPoolId: userPool.userPoolId,
      description: "PARADAYS order administrators.",
    });
    new cognito.CfnUserPoolGroup(this, "SupportGroup", {
      groupName: "support",
      userPoolId: userPool.userPoolId,
      description: "PARADAYS customer support staff.",
    });

    /** ID token을 API token으로 오인하지 않도록 access token 전용 resource server scope를 정의합니다. */
    const commerceApiScope = new cognito.ResourceServerScope({
      scopeName: "api",
      scopeDescription: "Access to PARADAYS member and commerce APIs.",
    });
    const commerceResourceServer = new cognito.UserPoolResourceServer(
      this,
      "CommerceApiResourceServer",
      {
        userPool,
        identifier: "paradays-commerce",
        userPoolResourceServerName: "PARADAYS Commerce API",
        scopes: [commerceApiScope],
      },
    );
    const commerceOAuthScope = cognito.OAuthScope.resourceServer(
      commerceResourceServer,
      commerceApiScope,
    );

    /** 브라우저는 secret 없는 public client와 Authorization Code + PKCE를 사용함. */
    const webClient = userPool.addClient("WebClient", {
      userPoolClientName: `${namePrefix}-web`,
      generateSecret: false,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PHONE,
          cognito.OAuthScope.PROFILE,
          commerceOAuthScope,
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    /**
     * 개발은 AWS managed prefix, 운영은 소유·ACM 검증이 끝난 custom domain을 사용합니다.
     * custom domain 인증서는 Cognito 요구사항에 따라 us-east-1에 발급한 public ACM 인증서여야 합니다.
     */
    const managedLoginDomain = props.customCognitoDomain
      ? userPool.addDomain("CustomManagedLoginDomain", {
          customDomain: {
            domainName: props.customCognitoDomain.domainName,
            certificate: acm.Certificate.fromCertificateArn(
              this,
              "CognitoCustomDomainCertificate",
              props.customCognitoDomain.certificateArn,
            ),
          },
        })
      : userPool.addDomain("ManagedLoginDomain", {
          cognitoDomain: { domainPrefix: props.managedLoginDomainPrefix },
        });

    /** Cognito 인증 외의 회원 프로필과 동의·배송지 식별자를 저장함. */
    const profileTable = new dynamodb.Table(this, "ProfileTable", {
      tableName: `${namePrefix}-profile`,
      partitionKey: { name: "userSub", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });

    /** 서버가 계산한 주문 금액 스냅샷과 상태를 저장함. */
    const orderTable = new dynamodb.Table(this, "OrderTable", {
      tableName: `${namePrefix}-order`,
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });
    orderTable.addGlobalSecondaryIndex({
      indexName: "userSub-createdAt-index",
      partitionKey: { name: "userSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /** Toss Payments 웹훅의 중복 수신을 막는 공급자 이벤트 기록을 저장함. */
    const paymentEventTable = new dynamodb.Table(this, "PaymentEventTable", {
      tableName: `${namePrefix}-payment-event`,
      partitionKey: {
        name: "providerEventId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });

    /** 판매용 상품은 draft와 published를 분리해 OCR·관리자 입력이 즉시 공개되지 않게 합니다. */
    const catalogTable = new dynamodb.Table(this, "CatalogTable", {
      tableName: `${namePrefix}-catalog`,
      partitionKey: { name: "productId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });
    /** 수동 매출과 변경 불가 마감 snapshot은 주문·카탈로그 item namespace와 섞이지 않음. */
    const salesLedgerTable = new dynamodb.Table(this, "SalesLedgerTable", {
      tableName: `${namePrefix}-sales-ledger`,
      partitionKey: { name: "businessDay", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "entryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    catalogTable.addGlobalSecondaryIndex({
      indexName: "publicationStatus-updatedAt-index",
      partitionKey: {
        name: "publicationStatus",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    catalogTable.addGlobalSecondaryIndex({
      indexName: "slug-updatedAt-index",
      partitionKey: { name: "slug", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /** 브랜드·쿠폰·캠페인은 별도 테이블로 보존해 상품과 권한·보존 정책을 분리합니다. */
    const brandTable = new dynamodb.Table(this, "BrandTable", {
      tableName: `${namePrefix}-brand`,
      partitionKey: { name: "brandId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });
    const couponTable = new dynamodb.Table(this, "CouponTable", {
      tableName: `${namePrefix}-coupon`,
      partitionKey: { name: "couponId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });
    const campaignTable = new dynamodb.Table(this, "CampaignTable", {
      tableName: `${namePrefix}-campaign`,
      partitionKey: { name: "campaignId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });

    /** OCR 원본은 저장하지 않고 검토 가능한 정규화 결과만 짧게 보관합니다. */
    const ocrJobTable = new dynamodb.Table(this, "OcrJobTable", {
      tableName: `${namePrefix}-ocr-job`,
      partitionKey: { name: "jobId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy,
    });

    /** 실제 Toss Payments server secret은 배포 뒤 Secrets Manager에 주입함. */
    const tossPaymentsSecret = new secretsmanager.Secret(
      this,
      "TossPaymentsCredentials",
      {
        secretName: `${namePrefix}/toss-payments`,
        description: "Toss Payments server secret. Do not store card data here.",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ provider: "toss-payments" }),
          generateStringKey: "bootstrapNonce",
          passwordLength: 32,
          excludePunctuation: true,
        },
        removalPolicy: dataRemovalPolicy,
      },
    );

    /** PaddleOCR endpoint·shared secret은 Lambda에만 전달되는 Secrets Manager JSON으로 관리합니다. */
    const paddleOcrSecret = new secretsmanager.Secret(this, "PaddleOcrCredentials", {
      secretName: `${namePrefix}/paddle-ocr`,
      description:
        "Private PaddleOCR service URL and required service-to-service shared secret.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ provider: "paddle-ocr" }),
        generateStringKey: "bootstrapNonce",
        passwordLength: 32,
        excludePunctuation: true,
      },
      removalPolicy: dataRemovalPolicy,
    });
    const privateOcrService = privateOcrIsEnabled(this)
      ? createPrivateOcrService(this, namePrefix)
      : undefined;
    const activePaddleOcrSecret = privateOcrService?.credentials ?? paddleOcrSecret;

    /** 인증된 프로필 API입니다. */
    const profileFunction = createCommerceFunction(this, "ProfileFunction", {
      entryFileName: "profile-handler.ts",
      environment: { PROFILE_TABLE_NAME: profileTable.tableName },
    });
    profileTable.grantReadWriteData(profileFunction);

    /** 인증된 주문 조회 API입니다. */
    const orderFunction = createCommerceFunction(this, "OrderFunction", {
      entryFileName: "order-handler.ts",
      environment: { ORDER_TABLE_NAME: orderTable.tableName },
    });
    orderTable.grantReadData(orderFunction);

    /** 서버 가격 재계산과 Toss 결제 준비 주문 생성을 맡는 checkout API입니다. */
    const checkoutFunction = createCommerceFunction(this, "CheckoutFunction", {
      entryFileName: "checkout-handler.ts",
      environment: {
        ORDER_TABLE_NAME: orderTable.tableName,
        CATALOG_TABLE_NAME: catalogTable.tableName,
        TOSS_PAYMENTS_SECRET_ARN: tossPaymentsSecret.secretArn,
      },
    });
    orderTable.grantReadWriteData(checkoutFunction);
    // checkout은 상품 행만 읽고, 재고 쓰기는 결제 승인 단계에서 일어남.
    catalogTable.grant(checkoutFunction, "dynamodb:GetItem");
    tossPaymentsSecret.grantRead(checkoutFunction);

    /** Toss redirect 성공 후 서버 승인을 맡는 공개 confirmation API입니다. */
    const paymentConfirmFunction = createCommerceFunction(
      this,
      "PaymentConfirmFunction",
      {
        entryFileName: "payment-confirm-handler.ts",
        environment: {
          ORDER_TABLE_NAME: orderTable.tableName,
          CATALOG_TABLE_NAME: catalogTable.tableName,
          TOSS_PAYMENTS_SECRET_ARN: tossPaymentsSecret.secretArn,
        },
      },
    );
    orderTable.grantReadWriteData(paymentConfirmFunction);
    // 재고 transaction은 revision을 읽어 Put으로 갱신하고 상품 행은 Update함.
    catalogTable.grant(
      paymentConfirmFunction,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    tossPaymentsSecret.grantRead(paymentConfirmFunction);

    /** PG 재조회와 주문 상태 전이를 맡는 공개 webhook API입니다. */
    const paymentWebhookFunction = createCommerceFunction(
      this,
      "PaymentWebhookFunction",
      {
        entryFileName: "payment-webhook-handler.ts",
        environment: {
          ORDER_TABLE_NAME: orderTable.tableName,
          CATALOG_TABLE_NAME: catalogTable.tableName,
          PAYMENT_EVENT_TABLE_NAME: paymentEventTable.tableName,
          TOSS_PAYMENTS_SECRET_ARN: tossPaymentsSecret.secretArn,
        },
      },
    );
    orderTable.grantReadWriteData(paymentWebhookFunction);
    catalogTable.grant(
      paymentWebhookFunction,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    paymentEventTable.grantReadWriteData(paymentWebhookFunction);
    tossPaymentsSecret.grantRead(paymentWebhookFunction);

    /** admin group 확인과 전체 환불 승인을 맡는 관리자 API입니다. */
    const adminRefundFunction = createCommerceFunction(this, "AdminRefundFunction", {
      entryFileName: "admin-refund-handler.ts",
      environment: {
        ORDER_TABLE_NAME: orderTable.tableName,
        CATALOG_TABLE_NAME: catalogTable.tableName,
        TOSS_PAYMENTS_SECRET_ARN: tossPaymentsSecret.secretArn,
        USER_POOL_ID: userPool.userPoolId,
      },
    });
    orderTable.grantReadWriteData(adminRefundFunction);
    catalogTable.grant(
      adminRefundFunction,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
    tossPaymentsSecret.grantRead(adminRefundFunction);

    /** admin group에서만 상품의 draft·발행 상태를 바꾸도록 서버 handler를 둡니다. */
    const adminCatalogFunction = createCommerceFunction(this, "AdminCatalogFunction", {
      entryFileName: "admin-catalog-handler.ts",
      environment: {
        CATALOG_TABLE_NAME: catalogTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
      },
    });
    catalogTable.grantReadWriteData(adminCatalogFunction);

    /**
     * 상품 이미지는 S3에만 보관하고, 관리자 브라우저는 프리사인 Put URL로 직접 업로드합니다.
     * 공개 GetObject는 products/ 접두사만 허용해 카탈로그 CDN 없이 HTTPS URL을 씁니다.
     */
    const productImageBucket = new s3.Bucket(this, "ProductImageBucket", {
      bucketName: undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag", "Content-Type", "Content-Length"],
          maxAge: 3600,
        },
      ],
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
    });
    productImageBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowPublicReadProductImages",
        actions: ["s3:GetObject"],
        resources: [productImageBucket.arnForObjects("products/*")],
        principals: [new iam.AnyPrincipal()],
      }),
    );

    const productImagePublicBaseUrl = `https://${productImageBucket.bucketRegionalDomainName}`;

    const adminCatalogUploadFunction = createCommerceFunction(
      this,
      "AdminCatalogUploadFunction",
      {
        entryFileName: "admin-catalog-upload-handler.ts",
        environment: {
          PRODUCT_IMAGE_BUCKET_NAME: productImageBucket.bucketName,
          PRODUCT_IMAGE_PUBLIC_BASE_URL: productImagePublicBaseUrl,
          USER_POOL_ID: userPool.userPoolId,
        },
      },
    );
    productImageBucket.grantPut(adminCatalogUploadFunction, "products/*");

    /** 운영 현황 카드는 주문·재고·쿠폰·마케팅 동의만 집계하고 민감 필드는 반환하지 않습니다. */
    const adminOverviewFunction = createCommerceFunction(
      this,
      "AdminOverviewFunction",
      {
        entryFileName: "admin-overview-handler.ts",
        environment: {
          ORDER_TABLE_NAME: orderTable.tableName,
          CATALOG_TABLE_NAME: catalogTable.tableName,
          COUPON_TABLE_NAME: couponTable.tableName,
          PROFILE_TABLE_NAME: profileTable.tableName,
          USER_POOL_ID: userPool.userPoolId,
        },
      },
    );
    orderTable.grantReadData(adminOverviewFunction);
    catalogTable.grantReadData(adminOverviewFunction);
    couponTable.grantReadData(adminOverviewFunction);
    profileTable.grantReadData(adminOverviewFunction);

    const adminSalesFunction = createCommerceFunction(this, "AdminSalesFunction", {
      entryFileName: "admin-sales-handler.ts",
      timeoutSeconds: 28,
      environment: {
        SALES_LEDGER_TABLE_NAME: salesLedgerTable.tableName,
        ORDER_TABLE_NAME: orderTable.tableName,
        CATALOG_TABLE_NAME: catalogTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
      },
    });
    salesLedgerTable.grant(
      adminSalesFunction,
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
    );
    catalogTable.grant(
      adminSalesFunction,
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem",
    );
    orderTable.grant(adminSalesFunction, "dynamodb:Scan");

    /** 브랜드·쿠폰·마케팅 초안은 admin group이 server-side 검증 뒤에만 관리합니다. */
    const adminOperationsFunction = createCommerceFunction(
      this,
      "AdminOperationsFunction",
      {
        entryFileName: "admin-operations-handler.ts",
        environment: {
          BRAND_TABLE_NAME: brandTable.tableName,
          COUPON_TABLE_NAME: couponTable.tableName,
          CAMPAIGN_TABLE_NAME: campaignTable.tableName,
          USER_POOL_ID: userPool.userPoolId,
        },
      },
    );
    brandTable.grantReadWriteData(adminOperationsFunction);
    couponTable.grantReadWriteData(adminOperationsFunction);
    campaignTable.grantReadWriteData(adminOperationsFunction);

    /** Cognito 회원 목록·그룹 조회는 별도 관리자 handler와 최소 IAM 권한으로 처리합니다. */
    const adminMemberFunction = createCommerceFunction(this, "AdminMemberFunction", {
      entryFileName: "admin-member-handler.ts",
      environment: { USER_POOL_ID: userPool.userPoolId },
    });
    adminMemberFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:ListUsers",
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    /** OCR 요청은 private PaddleOCR service로만 relay하고 원본 이미지·비밀을 영속화하지 않습니다. */
    const adminOcrFunction = createCommerceFunction(this, "AdminOcrFunction", {
      entryFileName: "admin-ocr-handler.ts",
      environment: {
        OCR_JOB_TABLE_NAME: ocrJobTable.tableName,
        PADDLE_OCR_SECRET_ARN: activePaddleOcrSecret.secretArn,
        USER_POOL_ID: userPool.userPoolId,
      },
      networking: privateOcrService?.networking,
    });
    ocrJobTable.grantReadWriteData(adminOcrFunction);
    activePaddleOcrSecret.grantRead(adminOcrFunction);
    // 임시 조치: 운영 OCR 보류 중에는 이 context key가 이미 배포된 OCR bundle과
    // scope 없는 route를 고정함. OCR 출시 때 cdk.json에서 이 key를 지움.
    const pinnedOcrCodeS3Key = this.node.tryGetContext("adminOcrPinnedCodeS3Key") as
      | string
      | undefined;
    if (pinnedOcrCodeS3Key)
      (adminOcrFunction.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
        "Code",
        {
          S3Bucket: `cdk-hnb659fds-assets-${this.account}-${this.region}`,
          S3Key: pinnedOcrCodeS3Key,
        },
      );
    const ocrRouteScopes = pinnedOcrCodeS3Key
      ? {}
      : { authorizationScopes: [commerceOAuthScope.scopeName] };

    /**
     * JWT group claim으로 admin이 확인되지 않을 때 관리자 Lambda가 Cognito에서
     * admin 그룹 소속을 재확인할 수 있게 최소 IAM을 부여함.
     */
    const adminGroupLookupStatement = new iam.PolicyStatement({
      actions: ["cognito-idp:AdminListGroupsForUser"],
      resources: [userPool.userPoolArn],
    });
    for (const adminFunction of [
      adminRefundFunction,
      adminCatalogFunction,
      adminCatalogUploadFunction,
      adminOverviewFunction,
      adminSalesFunction,
      adminOperationsFunction,
      adminOcrFunction,
    ]) {
      adminFunction.addToRolePolicy(adminGroupLookupStatement);
    }

    /** 공개 스토어는 발행된 상품만 읽는 최소 projection API를 사용합니다. */
    const publicCatalogFunction = createCommerceFunction(
      this,
      "PublicCatalogFunction",
      {
        entryFileName: "public-catalog-handler.ts",
        environment: { CATALOG_TABLE_NAME: catalogTable.tableName },
      },
    );
    catalogTable.grantReadData(publicCatalogFunction);

    /** 브라우저 출처를 allowlist로 제한한 HTTP API임. */
    const commerceApi = new apigwv2.HttpApi(this, "CommerceHttpApi", {
      apiName: `${namePrefix}-commerce-api`,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowHeaders: ["Authorization", "Content-Type", "X-Idempotency-Key"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(1),
      },
    });

    /** API Gateway가 Cognito access token의 issuer와 client ID를 검증하도록 구성함. */
    const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      userPool.userPoolProviderUrl,
      { jwtAudience: [webClient.userPoolClientId] },
    );

    /** 각 Lambda를 HTTP API route에 연결하고, confirm·webhook 공개 경로는 자체 검증으로 분리함. */
    const profileIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "ProfileIntegration",
      profileFunction,
    );
    const orderIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "OrderIntegration",
      orderFunction,
    );
    const checkoutIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "CheckoutIntegration",
      checkoutFunction,
    );
    const paymentConfirmIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "PaymentConfirmIntegration",
      paymentConfirmFunction,
    );
    const webhookIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "WebhookIntegration",
      paymentWebhookFunction,
    );
    const adminRefundIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminRefundIntegration",
      adminRefundFunction,
    );
    const adminCatalogIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminCatalogIntegration",
      adminCatalogFunction,
    );
    const adminCatalogUploadIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminCatalogUploadIntegration",
      adminCatalogUploadFunction,
    );
    const adminOverviewIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminOverviewIntegration",
      adminOverviewFunction,
    );
    const adminSalesIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminSalesIntegration",
      adminSalesFunction,
    );
    const adminOperationsIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminOperationsIntegration",
      adminOperationsFunction,
    );
    const adminMemberIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminMemberIntegration",
      adminMemberFunction,
    );
    const adminOcrIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AdminOcrIntegration",
      adminOcrFunction,
    );
    const publicCatalogIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "PublicCatalogIntegration",
      publicCatalogFunction,
    );

    commerceApi.addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration: profileIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/orders",
      methods: [apigwv2.HttpMethod.GET],
      integration: orderIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/orders/{orderId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: orderIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/checkout/sessions",
      methods: [apigwv2.HttpMethod.POST],
      integration: checkoutIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/payments/confirm",
      methods: [apigwv2.HttpMethod.POST],
      integration: paymentConfirmIntegration,
    });
    commerceApi.addRoutes({
      path: "/payments/webhook",
      methods: [apigwv2.HttpMethod.POST],
      integration: webhookIntegration,
    });
    const [, adminRefundGetRoute] = commerceApi.addRoutes({
      path: "/admin/orders/{orderId}/refunds",
      // 배포된 integration ID와 맞도록 POST가 공용 integration을 먼저 연결함.
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
      integration: adminRefundIntegration,
      authorizer: jwtAuthorizer,
    });
    // 배포된 stack은 이 GET route를 H-012 logical ID로 갖고 있음. 같은 route key를 다시 만들면
    // 충돌하므로, 이 ID를 유지해 배포가 제자리 갱신되게 함.
    (adminRefundGetRoute!.node.defaultChild as apigwv2.CfnRoute).overrideLogicalId(
      "H012AdminOrderGetRoute",
    );
    (
      adminRefundGetRoute!.node.findChild(
        "AdminRefundIntegration-Permission",
      ) as lambda.CfnPermission
    ).overrideLogicalId("H012AdminOrderGetPermission");
    commerceApi.addRoutes({
      path: "/admin/catalog/products",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: adminCatalogIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/catalog/products/{productId}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminCatalogIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/catalog/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: adminCatalogUploadIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/overview",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminOverviewIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/sales/{businessDay}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: adminSalesIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/brands",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/brands/{brandId}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/coupons",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/coupons/{couponId}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/campaigns",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/campaigns/{campaignId}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminOperationsIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/members",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminMemberIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/members/{username}/groups",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.DELETE],
      integration: adminMemberIntegration,
      authorizer: jwtAuthorizer,
    });
    commerceApi.addRoutes({
      path: "/admin/ocr/jobs",
      methods: [apigwv2.HttpMethod.POST],
      integration: adminOcrIntegration,
      authorizer: jwtAuthorizer,
      ...ocrRouteScopes,
    });
    commerceApi.addRoutes({
      path: "/admin/ocr/jobs/{jobId}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH],
      integration: adminOcrIntegration,
      authorizer: jwtAuthorizer,
      ...ocrRouteScopes,
    });
    commerceApi.addRoutes({
      path: "/catalog/products",
      methods: [apigwv2.HttpMethod.GET],
      integration: publicCatalogIntegration,
    });

    /** 프런트와 CI가 안전하게 참조할 수 있는 식별자만 CloudFormation output으로 내보냄. */
    const outputPrefix = toPascalCase(`${props.applicationName}-${props.stage}`);
    new CfnOutput(this, "CommerceApiUrl", {
      value: commerceApi.apiEndpoint,
      exportName: `${outputPrefix}CommerceApiUrl`,
    });
    new CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
      exportName: `${outputPrefix}CognitoUserPoolId`,
    });
    new CfnOutput(this, "CognitoWebClientId", {
      value: webClient.userPoolClientId,
      exportName: `${outputPrefix}CognitoWebClientId`,
    });
    new CfnOutput(this, "CognitoCommerceScope", {
      value: commerceOAuthScope.scopeName,
      exportName: `${outputPrefix}CognitoCommerceScope`,
    });
    new CfnOutput(this, "CognitoManagedLoginUrl", {
      value: managedLoginDomain.baseUrl(),
      exportName: `${outputPrefix}CognitoManagedLoginUrl`,
    });
    new CfnOutput(this, "TossPaymentsSecretArn", {
      value: tossPaymentsSecret.secretArn,
      exportName: `${outputPrefix}TossPaymentsSecretArn`,
    });
    new CfnOutput(this, "ProfileTableName", {
      value: profileTable.tableName,
      exportName: `${outputPrefix}ProfileTableName`,
    });
    new CfnOutput(this, "OrderTableName", {
      value: orderTable.tableName,
      exportName: `${outputPrefix}OrderTableName`,
    });
    new CfnOutput(this, "PaymentEventTableName", {
      value: paymentEventTable.tableName,
      exportName: `${outputPrefix}PaymentEventTableName`,
    });
    new CfnOutput(this, "CatalogTableName", {
      value: catalogTable.tableName,
      exportName: `${outputPrefix}CatalogTableName`,
    });
    new CfnOutput(this, "SalesLedgerTableName", {
      value: salesLedgerTable.tableName,
      exportName: `${outputPrefix}SalesLedgerTableName`,
    });
    new CfnOutput(this, "ProductImageBucketName", {
      value: productImageBucket.bucketName,
      exportName: `${outputPrefix}ProductImageBucketName`,
    });
    new CfnOutput(this, "ProductImagePublicBaseUrl", {
      value: productImagePublicBaseUrl,
      exportName: `${outputPrefix}ProductImagePublicBaseUrl`,
    });
    new CfnOutput(this, "BrandTableName", {
      value: brandTable.tableName,
      exportName: `${outputPrefix}BrandTableName`,
    });
    new CfnOutput(this, "CouponTableName", {
      value: couponTable.tableName,
      exportName: `${outputPrefix}CouponTableName`,
    });
    new CfnOutput(this, "CampaignTableName", {
      value: campaignTable.tableName,
      exportName: `${outputPrefix}CampaignTableName`,
    });
    new CfnOutput(this, "OcrJobTableName", {
      value: ocrJobTable.tableName,
      exportName: `${outputPrefix}OcrJobTableName`,
    });
    new CfnOutput(this, "PaddleOcrSecretArn", {
      value: activePaddleOcrSecret.secretArn,
      exportName: `${outputPrefix}PaddleOcrSecretArn`,
    });
  }
}
