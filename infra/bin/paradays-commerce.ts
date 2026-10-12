/**
 * 역할: PARADAYS 상거래 AWS CDK 앱의 진입점임.
 * 기능: context 값을 검증해 환경별 CommerceStack 인스턴스를 생성함.
 */

import * as cdk from "aws-cdk-lib";
import { CommerceStack } from "../lib/paradays-commerce-stack.js";

/** CDK context에서 문자열 값을 읽고, 없으면 안전한 기본값을 사용함. */
function readStringContext(app: cdk.App, key: string, fallback: string): string {
  const value = app.node.tryGetContext(key);

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`CDK context '${key}' must be a non-empty string.`);
  }

  return value.trim();
}

/** 선택 context는 비어 있으면 미설정으로, 값이 있으면 정규화된 문자열로 읽습니다. */
function readOptionalStringContext(app: cdk.App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);

  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`CDK context '${key}' must be a non-empty string when set.`);
  }

  return value.trim();
}

/** CDK context에서 URL 배열을 읽어 잘못된 구성으로 인한 공개 CORS를 방지함. */
function readUrlListContext(app: cdk.App, key: string): string[] {
  const value = app.node.tryGetContext(key);

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`CDK context '${key}' must be a non-empty URL array.`);
  }

  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`CDK context '${key}' contains a non-string URL.`);
    }

    try {
      return new URL(entry).toString().replace(/\/$/, "");
    } catch {
      throw new Error(`CDK context '${key}' contains an invalid URL: ${entry}`);
    }
  });
}

/** Cognito 도메인 prefix의 AWS 제약을 배포 전에 빠르게 확인함. */
function validateManagedLoginDomainPrefix(prefix: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
    throw new Error(
      "managedLoginDomainPrefix must use 1-63 lowercase letters, numbers, or hyphens.",
    );
  }
}

/** Cognito custom domain에는 protocol·path 없이 소유한 DNS hostname만 받습니다. */
function validateCustomCognitoDomain(domainName: string): void {
  if (
    domainName.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      domainName,
    )
  ) {
    throw new Error(
      "cognitoCustomDomain must be a lowercase DNS hostname without protocol or path.",
    );
  }
}

/** Cognito custom domain 인증서는 반드시 us-east-1 public ACM certificate를 사용합니다. */
function validateCustomCognitoDomainCertificateArn(certificateArn: string): void {
  const parts = certificateArn.split(":");

  if (
    parts.length !== 6 ||
    !["aws", "aws-us-gov", "aws-cn"].includes(parts[1]) ||
    parts[2] !== "acm" ||
    parts[3] !== "us-east-1" ||
    !/^\d{12}$/.test(parts[4]) ||
    !/^certificate\/[0-9a-f-]{36}$/i.test(parts[5])
  ) {
    throw new Error(
      "cognitoCustomDomainCertificateArn must be a public ACM certificate ARN from us-east-1.",
    );
  }
}

const app = new cdk.App();
const applicationName = readStringContext(app, "appName", "paradays");
const stage = readStringContext(app, "stage", "dev");
const managedLoginDomainPrefix = readStringContext(
  app,
  "managedLoginDomainPrefix",
  `${applicationName}-${stage}-web`,
);

validateManagedLoginDomainPrefix(managedLoginDomainPrefix);

const cognitoCustomDomain = readOptionalStringContext(app, "cognitoCustomDomain");
const cognitoCustomDomainCertificateArn = readOptionalStringContext(
  app,
  "cognitoCustomDomainCertificateArn",
);

if (Boolean(cognitoCustomDomain) !== Boolean(cognitoCustomDomainCertificateArn)) {
  throw new Error(
    "cognitoCustomDomain and cognitoCustomDomainCertificateArn must be set together.",
  );
}

if (cognitoCustomDomain) {
  validateCustomCognitoDomain(cognitoCustomDomain);
  validateCustomCognitoDomainCertificateArn(cognitoCustomDomainCertificateArn!);
}

/** account와 region은 배포 시 CDK bootstrap 자격증명에서만 읽음. */
const environment: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-2",
};

new CommerceStack(app, `${applicationName}-${stage}-commerce`, {
  env: environment,
  applicationName,
  stage,
  managedLoginDomainPrefix,
  allowedOrigins: readUrlListContext(app, "allowedOrigins"),
  callbackUrls: readUrlListContext(app, "callbackUrls"),
  logoutUrls: readUrlListContext(app, "logoutUrls"),
  ...(cognitoCustomDomain && cognitoCustomDomainCertificateArn
    ? {
        customCognitoDomain: {
          domainName: cognitoCustomDomain,
          certificateArn: cognitoCustomDomainCertificateArn,
        },
      }
    : {}),
});
