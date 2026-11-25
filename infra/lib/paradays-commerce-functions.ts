/** 역할: 상거래 Lambda(NodejsFunction)를 공통 runtime·제한 시간·log group 설정으로 만드는 CDK 도우미임. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** 상거래 Lambda 생성에 필요한 최소 설정을 표현함. */
export interface CommerceFunctionOptions {
  readonly entryFileName: string;
  readonly environment: Record<string, string>;
  readonly timeoutSeconds?: number;
  readonly networking?: Readonly<{
    vpc: ec2.IVpc;
    vpcSubnets: ec2.SubnetSelection;
    securityGroups: ec2.ISecurityGroup[];
  }>;
}

/** 현재 파일의 위치를 기준으로 Lambda TypeScript 진입 파일을 안정적으로 찾음. */
const stackDirectory = dirname(fileURLToPath(import.meta.url));

/** 환경명을 CloudFormation 논리 이름에 안전하게 쓰기 위한 PascalCase 값으로 만듦. */
export function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * 공통 보안 설정을 가진 Node.js 상거래 Lambda를 생성함.
 * 각 handler는 카드정보를 직접 취급하지 않고, 주문·PG API 요청만 처리함.
 */
export function createCommerceFunction(
  scope: Construct,
  id: string,
  options: CommerceFunctionOptions,
): lambdaNodejs.NodejsFunction {
  const functionName = `${Stack.of(scope).stackName}-${id}`;
  // 명시적 log group으로 보존 기간을 관리하고, deprecated Lambda logRetention custom resource를 피합니다.
  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
  });

  return new lambdaNodejs.NodejsFunction(scope, id, {
    functionName,
    entry: join(stackDirectory, "..", "lambda", options.entryFileName),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    timeout: Duration.seconds(options.timeoutSeconds ?? 15),
    memorySize: 256,
    tracing: lambda.Tracing.ACTIVE,
    logGroup,
    environment: options.environment,
    ...options.networking,
    bundling: {
      minify: false,
      sourceMap: true,
      target: "node22",
    },
  });
}
