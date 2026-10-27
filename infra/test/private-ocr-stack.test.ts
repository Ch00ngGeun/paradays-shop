/**
 * 역할: private PaddleOCR opt-in CDK 계약과 opt-out 보존 동작을 검증합니다.
 * 기능: 임시 Cloud Assembly에서만 합성해 네트워크·이미지 URI·권한 경계를 확인합니다.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App, type Environment, type Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { CommerceStack } from "../lib/paradays-commerce-stack.js";

const TEST_ACCOUNT = "123456789012";
const TEST_REGION = "ap-northeast-2";
const TEST_DIGEST = "a".repeat(64);
const TEST_IMAGE_URI =
  `${TEST_ACCOUNT}.dkr.ecr.${TEST_REGION}.amazonaws.com/paradays/paddle-ocr` +
  `@sha256:${TEST_DIGEST}`;
const CONCRETE_ENVIRONMENT: Environment = {
  account: TEST_ACCOUNT,
  region: TEST_REGION,
};

interface StackFixtureOptions {
  readonly privateService?: boolean | string;
  readonly imageUri?: string;
  readonly concreteEnvironment?: boolean;
}

interface StackFixture {
  readonly stack: Stack;
  readonly cleanup: () => void;
}

/** 프로젝트 cdk.out 대신 OS 임시 경로에만 asset bundle과 assembly를 씁니다. */
function createStackFixture(options: StackFixtureOptions = {}): StackFixture {
  const outdir = mkdtempSync(join(tmpdir(), "paradays-private-ocr-stack-"));

  try {
    const app = new App({
      outdir,
      autoSynth: false,
      context: {
        paddleOcrPrivateService: options.privateService ?? false,
        ...(options.imageUri === undefined
          ? {}
          : { paddleOcrImageUri: options.imageUri }),
      },
    });
    const stack = new CommerceStack(app, "PrivateOcrContractTest", {
      env: options.concreteEnvironment === false ? undefined : CONCRETE_ENVIRONMENT,
      applicationName: "paradays",
      stage: "test",
      managedLoginDomainPrefix: "paradays-test-login",
      allowedOrigins: ["https://admin.example.test"],
      callbackUrls: ["https://admin.example.test/auth/callback"],
      logoutUrls: ["https://admin.example.test"],
    });

    return {
      stack,
      cleanup: () => rmSync(outdir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(outdir, { recursive: true, force: true });
    throw error;
  }
}

/** Template.fromStack의 번들 산출물도 항상 임시 디렉터리와 함께 폐기합니다. */
function synthesize(options: StackFixtureOptions): Template {
  const fixture = createStackFixture(options);

  try {
    return Template.fromStack(fixture.stack);
  } finally {
    fixture.cleanup();
  }
}

/** 생성만 검증하는 실패 케이스도 임시 경로를 남기지 않습니다. */
function constructAndCleanup(options: StackFixtureOptions): void {
  const fixture = createStackFixture(options);
  fixture.cleanup();
}

function resourceText(template: Template, resourceType: string): string {
  return JSON.stringify(template.findResources(resourceType));
}

function assertCognitoAndDataStoresArePreserved(template: Template): void {
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.hasResourceProperties(
    "AWS::Cognito::UserPool",
    Match.objectLike({ UsernameAttributes: ["email"] }),
  );
  template.resourceCountIs("AWS::DynamoDB::Table", 9);
  template.hasResourceProperties(
    "AWS::DynamoDB::Table",
    Match.objectLike({
      KeySchema: [
        { AttributeName: "businessDay", KeyType: "HASH" },
        { AttributeName: "entryId", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
    }),
  );
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({
      KeySchema: [
        { AttributeName: "businessDay", KeyType: "HASH" },
        { AttributeName: "entryId", KeyType: "RANGE" },
      ],
    }),
  });
  template.hasResourceProperties(
    "AWS::ApiGatewayV2::Route",
    Match.objectLike({
      RouteKey: "GET /admin/sales/{businessDay}",
      AuthorizationType: "JWT",
    }),
  );
  template.hasResourceProperties(
    "AWS::ApiGatewayV2::Route",
    Match.objectLike({
      RouteKey: "POST /admin/sales/{businessDay}",
      AuthorizationType: "JWT",
    }),
  );
  template.hasResourceProperties(
    "AWS::DynamoDB::Table",
    Match.objectLike({
      AttributeDefinitions: Match.arrayWith([
        Match.objectLike({ AttributeName: "jobId", AttributeType: "S" }),
      ]),
    }),
  );
}

test("private OCR opt-in은 concrete 환경의 digest-pinned private ECR URI만 받습니다", () => {
  const rejectedUris: ReadonlyArray<readonly [string | undefined, RegExp]> = [
    [undefined, /paddleOcrImageUri must be a private ECR repository URI/],
    [
      `${TEST_ACCOUNT}.dkr.ecr.${TEST_REGION}.amazonaws.com/paradays/paddle-ocr:latest`,
      /paddleOcrImageUri must be a private ECR repository URI/,
    ],
    [
      `${TEST_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/paradays/paddle-ocr@sha256:${TEST_DIGEST}`,
      /paddleOcrImageUri must belong to the stack account, region, and ECR DNS suffix/,
    ],
    [
      `${TEST_ACCOUNT}.dkr.ecr.${TEST_REGION}.amazonaws.com/paradays/paddle-ocr@sha256:${"A".repeat(64)}`,
      /paddleOcrImageUri must be a private ECR repository URI/,
    ],
  ];

  for (const [imageUri, error] of rejectedUris) {
    assert.throws(() => constructAndCleanup({ privateService: true, imageUri }), error);
  }

  assert.throws(
    () =>
      constructAndCleanup({
        privateService: true,
        imageUri: TEST_IMAGE_URI,
        concreteEnvironment: false,
      }),
    /Private OCR image validation requires a concrete stack account and region/,
  );
});

test("private OCR opt-out은 bootstrap 리소스를 만들지 않고 기존 Cognito·DynamoDB·secret을 보존합니다", () => {
  const template = synthesize({ privateService: false });
  for (const prefix of [
    "CheckoutFunction",
    "PaymentConfirmFunction",
    "PaymentWebhookFunction",
    "AdminRefundFunction",
  ]) {
    const functions = Object.entries(
      template.findResources("AWS::Lambda::Function"),
    ).filter(([id]) => id.startsWith(prefix));
    assert.equal(functions.length, 1);
    assert.ok(functions[0]![1].Properties.Environment.Variables.CATALOG_TABLE_NAME);
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(
      ([id]) => id.startsWith(prefix),
    );
    assert.ok(JSON.stringify(policies).includes("CatalogTable"));
  }
  // GET is added together with the refund handler that serves it read-only.
  for (const method of ["POST"])
    template.hasResourceProperties(
      "AWS::ApiGatewayV2::Route",
      Match.objectLike({
        RouteKey: `${method} /admin/orders/{orderId}/refunds`,
        AuthorizationType: "JWT",
      }),
    );

  for (const resourceType of [
    "AWS::EC2::VPC",
    "AWS::ApiGateway::RestApi",
    "AWS::ApiGateway::VpcLink",
    "AWS::ECS::Service",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
  ]) {
    template.resourceCountIs(resourceType, 0);
  }
  template.hasResourceProperties(
    "AWS::SecretsManager::Secret",
    Match.objectLike({
      Description:
        "Private PaddleOCR service URL and required service-to-service shared secret.",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "bootstrapNonce",
      }),
    }),
  );
  assertCognitoAndDataStoresArePreserved(template);
});

test("private OCR opt-in은 isolated service 경계와 shared runtime credentials를 합성합니다", () => {
  const template = synthesize({
    privateService: true,
    imageUri: TEST_IMAGE_URI,
  });

  template.resourceCountIs("AWS::ECR::Repository", 0);
  template.resourceCountIs("AWS::EC2::VPC", 1);
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.resourceCountIs("AWS::EC2::InternetGateway", 0);
  template.hasResourceProperties(
    "AWS::EC2::VPC",
    Match.objectLike({ EnableDnsHostnames: true, EnableDnsSupport: true }),
  );

  template.resourceCountIs("AWS::EC2::VPCEndpoint", 8);
  template.hasResourceProperties(
    "AWS::EC2::VPCEndpoint",
    Match.objectLike({ VpcEndpointType: "Interface", PrivateDnsEnabled: true }),
  );
  const endpoints = resourceText(template, "AWS::EC2::VPCEndpoint");
  for (const serviceName of [
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "cognito-idp",
    "execute-api",
  ]) {
    assert.match(endpoints, new RegExp(serviceName.replace(".", "\\.")));
  }

  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  template.hasResourceProperties(
    "AWS::ApiGateway::RestApi",
    Match.objectLike({
      EndpointConfiguration: Match.objectLike({
        Types: ["PRIVATE"],
        VpcEndpointIds: Match.arrayWith([Match.objectLike({})]),
      }),
    }),
  );
  const providerApi = resourceText(template, "AWS::ApiGateway::RestApi");
  assert.match(providerApi, /aws:SourceVpce/);
  assert.match(providerApi, /execute-api:Invoke/);

  template.resourceCountIs("AWS::ApiGateway::VpcLink", 1);
  template.hasResourceProperties(
    "AWS::ApiGateway::VpcLink",
    Match.objectLike({ TargetArns: Match.arrayWith([Match.objectLike({})]) }),
  );
  template.hasResourceProperties(
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    Match.objectLike({ Type: "network", Scheme: "internal" }),
  );
  template.hasResourceProperties(
    "AWS::ElasticLoadBalancingV2::Listener",
    Match.objectLike({ Port: 8000, Protocol: "TCP" }),
  );
  template.hasResourceProperties(
    "AWS::ElasticLoadBalancingV2::TargetGroup",
    Match.objectLike({
      Port: 8000,
      Protocol: "TCP",
      HealthCheckProtocol: "HTTP",
      HealthCheckPath: "/readyz",
      Matcher: Match.objectLike({ HttpCode: "200" }),
    }),
  );

  template.hasResourceProperties(
    "AWS::ECS::TaskDefinition",
    Match.objectLike({
      Cpu: "2048",
      Memory: "4096",
      RequiresCompatibilities: ["FARGATE"],
      NetworkMode: "awsvpc",
      RuntimePlatform: Match.objectLike({
        CpuArchitecture: "X86_64",
        OperatingSystemFamily: "LINUX",
      }),
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "Provider",
          User: "10001",
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 8000, Protocol: "tcp" }),
          ]),
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: "PADDLE_OCR_SHARED_SECRET" }),
          ]),
        }),
      ]),
    }),
  );
  template.hasResourceProperties(
    "AWS::ECS::Service",
    Match.objectLike({
      LaunchType: "FARGATE",
      DesiredCount: 1,
      EnableExecuteCommand: false,
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
      }),
    }),
  );

  template.hasResourceProperties(
    "AWS::SecretsManager::Secret",
    Match.objectLike({
      Description: "Generated credentials shared by the private OCR relay and worker.",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "sharedSecret",
        PasswordLength: 48,
        ExcludePunctuation: true,
      }),
    }),
  );
  template.hasResourceProperties(
    "AWS::Lambda::Function",
    Match.objectLike({
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          OCR_JOB_TABLE_NAME: Match.anyValue(),
          PADDLE_OCR_SECRET_ARN: Match.anyValue(),
          USER_POOL_ID: Match.anyValue(),
        }),
      }),
      VpcConfig: Match.objectLike({
        SecurityGroupIds: Match.anyValue(),
        SubnetIds: Match.anyValue(),
      }),
    }),
  );
  const lambdaFunctions = resourceText(template, "AWS::Lambda::Function");
  const iamPolicies = resourceText(template, "AWS::IAM::Policy");
  assert.match(lambdaFunctions, /PADDLE_OCR_SECRET_ARN/);
  assert.match(lambdaFunctions, /PaddleOcrRuntimeCredentials/);
  assert.match(iamPolicies, /secretsmanager:GetSecretValue/);
  assert.match(iamPolicies, /PaddleOcrRuntimeCredentials/);

  template.hasResourceProperties(
    "AWS::SecretsManager::Secret",
    Match.objectLike({
      Description:
        "Private PaddleOCR service URL and required service-to-service shared secret.",
      GenerateSecretString: Match.objectLike({ GenerateStringKey: "bootstrapNonce" }),
    }),
  );
  assertCognitoAndDataStoresArePreserved(template);
});
