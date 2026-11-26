/** 역할: context로 켤 때만 비공개 PaddleOCR 서비스(ECS·private REST API·VPC link)를 CDK로 만드는 opt-in 구성임. */
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { CfnOutput, Duration, RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { type CommerceFunctionOptions } from "./paradays-commerce-functions.js";

/** CLI context는 문자열이고, 코드에서 넣은 context는 boolean일 수 있음. */
export function privateOcrIsEnabled(scope: Construct): boolean {
  const value: unknown = scope.node.tryGetContext("paddleOcrPrivateService");

  if (value === undefined || value === false || value === "false") {
    return false;
  }

  if (value === true || value === "true") {
    return true;
  }

  throw new Error("paddleOcrPrivateService must be true or false when configured.");
}

/**
 * opt-in에는 검증·게시된 ECR URI를 담은 context paddleOcrImageUri가 필요함:
 * ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY@sha256:64-소문자-hex.
 * repository는 이 stack과 같은 account·region에 있어야 함. stack 환경이 정해지지
 * 않으면 fail-closed로 처리하므로 먼저 구체적인 배포 환경을 지정해야 함.
 * repository import는 registry를 만들지 않고 bootstrap 정책도 바꾸지 않음.
 */
function readPrivateOcrImage(scope: Construct): ecs.EcrImage {
  const value: unknown = scope.node.tryGetContext("paddleOcrImageUri");
  const match =
    typeof value === "string"
      ? /^(\d{12})\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-\d)\.(amazonaws\.com(?:\.cn)?)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[0-9a-f]{64})$/.exec(
          value,
        )
      : null;

  if (!match || match[4].length < 2 || match[4].length > 256) {
    throw new Error(
      "paddleOcrImageUri must be a private ECR repository URI pinned to a complete SHA256 digest.",
    );
  }

  const stack = Stack.of(scope);
  if (Token.isUnresolved(stack.account) || Token.isUnresolved(stack.region)) {
    throw new Error(
      "Private OCR image validation requires a concrete stack account and region.",
    );
  }
  const expectedSuffix = stack.region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  if (
    match[1] !== stack.account ||
    match[2] !== stack.region ||
    match[3] !== expectedSuffix
  ) {
    throw new Error(
      "paddleOcrImageUri must belong to the stack account, region, and ECR DNS suffix.",
    );
  }

  const repository = ecr.Repository.fromRepositoryName(
    scope,
    "PaddleOcrImageRepository",
    match[4],
  );
  // CDK는 정확한 @sha256 이미지를 연결하고 task execution role에 ECR pull 권한만 줌.
  // repository 접근 범위는 import한 이 repository로 한정됨.
  return ecs.ContainerImage.fromEcrRepository(repository, match[5]);
}

/**
 * 자체 DNS domain 없이 신뢰할 수 있는 AWS HTTPS를 제공함. REST endpoint는
 * PRIVATE이고 HTTP backend는 VPC link로만 접근할 수 있음. model 파일은 이미지에
 * 포함되어 실행 중 internet 경로가 없음. opt-out이면 이 리소스를 하나도 만들지
 * 않고 기존 secret을 보존함.
 */
export function createPrivateOcrService(
  scope: Construct,
  namePrefix: string,
): Readonly<{
  credentials: secretsmanager.Secret;
  networking: NonNullable<CommerceFunctionOptions["networking"]>;
}> {
  const image = readPrivateOcrImage(scope);
  const isolatedSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
  const vpc = new ec2.Vpc(scope, "PaddleOcrVpc", {
    maxAzs: 2,
    natGateways: 0,
    enableDnsHostnames: true,
    enableDnsSupport: true,
    subnetConfiguration: [
      { name: "OcrIsolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    ],
  });
  const lambdaSecurityGroup = new ec2.SecurityGroup(
    scope,
    "PaddleOcrLambdaSecurityGroup",
    {
      vpc,
      allowAllOutbound: false,
      description: "Only the OCR relay Lambda may invoke the private provider API.",
    },
  );
  const taskSecurityGroup = new ec2.SecurityGroup(scope, "PaddleOcrTaskSecurityGroup", {
    vpc,
    allowAllOutbound: false,
    description: "OCR worker accepts only the private NLB and AWS endpoint traffic.",
  });
  const endpointSecurityGroup = new ec2.SecurityGroup(
    scope,
    "PaddleOcrEndpointSecurityGroup",
    {
      vpc,
      allowAllOutbound: false,
      description: "AWS service endpoints for the isolated OCR runtime.",
    },
  );
  endpointSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(443));
  endpointSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(443));
  // Gateway endpoint는 AWS 공개 서비스 prefix를 쓰지만, 격리 subnet route table에는
  // 기본 internet/NAT 경로가 없음. HTTPS는 나열한 AWS endpoint로만 나갈 수 있어
  // 이 VPC에서는 OCR model 다운로드가 실행될 수 없음.
  lambdaSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
  taskSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

  vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });
  vpc.addGatewayEndpoint("DynamoDb", {
    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
  });
  const serviceEndpoints = [
    ["EcrApi", ec2.InterfaceVpcEndpointAwsService.ECR],
    ["EcrDocker", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
    ["Logs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ["Secrets", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
    ["Cognito", ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP],
  ] as const;
  const endpointDependencies = serviceEndpoints.map(([id, service]) =>
    vpc.addInterfaceEndpoint(id, {
      service,
      subnets: isolatedSubnets,
      securityGroups: [endpointSecurityGroup],
      privateDnsEnabled: true,
      open: false,
    }),
  );
  const apiEndpointSecurityGroup = new ec2.SecurityGroup(
    scope,
    "PaddleOcrApiEndpointSecurityGroup",
    {
      vpc,
      allowAllOutbound: false,
      description: "Only the OCR Lambda can open the provider HTTPS endpoint.",
    },
  );
  apiEndpointSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(443));
  const apiEndpoint = vpc.addInterfaceEndpoint("ProviderApi", {
    service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
    subnets: isolatedSubnets,
    securityGroups: [apiEndpointSecurityGroup],
    privateDnsEnabled: true,
    open: false,
  });
  const providerApi = new apigateway.RestApi(scope, "PaddleOcrProviderApi", {
    restApiName: `${namePrefix}-private-paddle-ocr`,
    endpointConfiguration: {
      types: [apigateway.EndpointType.PRIVATE],
      vpcEndpoints: [apiEndpoint],
    },
    deployOptions: {
      stageName: "provider",
      loggingLevel: apigateway.MethodLoggingLevel.OFF,
      dataTraceEnabled: false,
      metricsEnabled: true,
      throttlingRateLimit: 2,
      throttlingBurstLimit: 2,
    },
    cloudWatchRole: false,
  });
  providerApi.grantInvokeFromVpcEndpointsOnly([apiEndpoint]);
  const baseUrl = `https://${providerApi.restApiId}.execute-api.${Stack.of(scope).region}.${Stack.of(scope).urlSuffix}/provider`;
  const credentials = new secretsmanager.Secret(scope, "PaddleOcrRuntimeCredentials", {
    secretName: `${namePrefix}/paddle-ocr-runtime`,
    description: "Generated credentials shared by the private OCR relay and worker.",
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ baseUrl }),
      generateStringKey: "sharedSecret",
      passwordLength: 48,
      excludePunctuation: true,
    },
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const cluster = new ecs.Cluster(scope, "PaddleOcrCluster", {
    vpc,
    clusterName: `${namePrefix}-paddle-ocr`,
  });
  const taskDefinition = new ecs.FargateTaskDefinition(scope, "PaddleOcrTask", {
    cpu: 2048,
    memoryLimitMiB: 4096,
    runtimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
  });
  const logGroup = new logs.LogGroup(scope, "PaddleOcrServiceLogGroup", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const container = taskDefinition.addContainer("Provider", {
    image,
    user: "10001",
    environment: {
      PADDLE_OCR_SERVICE_HOST: "0.0.0.0",
      PADDLE_OCR_SERVICE_PORT: "8000",
      PADDLE_OCR_MODEL_LANGUAGE: "korean",
      PADDLE_OCR_PRELOAD_MODEL: "true",
      PADDLE_OCR_LOG_LEVEL: "warning",
    },
    secrets: {
      PADDLE_OCR_SHARED_SECRET: ecs.Secret.fromSecretsManager(
        credentials,
        "sharedSecret",
      ),
    },
    logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "provider" }),
    healthCheck: {
      command: [
        "CMD-SHELL",
        "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)\"",
      ],
      interval: Duration.seconds(30),
      timeout: Duration.seconds(3),
      startPeriod: Duration.seconds(120),
      retries: 3,
    },
  });
  container.addPortMappings({ containerPort: 8000, protocol: ecs.Protocol.TCP });
  const service = new ecs.FargateService(scope, "PaddleOcrService", {
    cluster,
    taskDefinition,
    desiredCount: 1,
    assignPublicIp: false,
    vpcSubnets: isolatedSubnets,
    securityGroups: [taskSecurityGroup],
    healthCheckGracePeriod: Duration.seconds(180),
    circuitBreaker: { enable: true, rollback: true },
    enableExecuteCommand: false,
  });
  service.node.addDependency(...endpointDependencies);
  const nlbSecurityGroup = new ec2.SecurityGroup(scope, "PaddleOcrNlbSecurityGroup", {
    vpc,
    allowAllOutbound: false,
    description: "PrivateLink-only provider load balancer; no direct inbound rules.",
  });
  const nlb = new elbv2.NetworkLoadBalancer(scope, "PaddleOcrLoadBalancer", {
    vpc,
    vpcSubnets: isolatedSubnets,
    internetFacing: false,
    crossZoneEnabled: true,
    securityGroups: [nlbSecurityGroup],
    // API Gateway VPC link 트래픽은 AWS PrivateLink로 들어옴. NLB에는 직접 inbound
    // 규칙이 없고, worker 수신은 여전히 이 SG를 거쳐야 함.
    enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: false,
  });
  taskSecurityGroup.addIngressRule(nlbSecurityGroup, ec2.Port.tcp(8000));
  nlbSecurityGroup.addEgressRule(taskSecurityGroup, ec2.Port.tcp(8000));
  const listener = nlb.addListener("Provider", { port: 8000 });
  listener.addTargets("Worker", {
    port: 8000,
    targets: [service],
    healthCheck: {
      protocol: elbv2.Protocol.HTTP,
      path: "/readyz",
      port: "8000",
      healthyHttpCodes: "200",
      interval: Duration.seconds(30),
    },
  });
  const vpcLink = new apigateway.VpcLink(scope, "PaddleOcrVpcLink", {
    targets: [nlb],
    description: "Private OCR provider integration.",
  });
  providerApi.root.addResource("ocr").addMethod(
    "POST",
    new apigateway.HttpIntegration(`http://${nlb.loadBalancerDnsName}:8000/ocr`, {
      httpMethod: "POST",
      proxy: true,
      options: {
        connectionType: apigateway.ConnectionType.VPC_LINK,
        vpcLink,
        timeout: Duration.seconds(11),
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_TEMPLATES,
        requestParameters: {
          "integration.request.header.Authorization":
            "method.request.header.Authorization",
          "integration.request.header.Content-Type":
            "method.request.header.Content-Type",
        },
      },
    }),
    {
      authorizationType: apigateway.AuthorizationType.NONE,
      requestParameters: {
        "method.request.header.Authorization": true,
        "method.request.header.Content-Type": true,
      },
    },
  );

  for (const [id, value] of [
    ["PaddleOcrPrivateApiUrl", baseUrl],
    ["PaddleOcrRuntimeSecretArn", credentials.secretArn],
    ["PaddleOcrContainerImageUri", image.imageName],
    ["PaddleOcrClusterName", cluster.clusterName],
    ["PaddleOcrServiceName", service.serviceName],
  ]) {
    new CfnOutput(scope, id, { value });
  }

  return {
    credentials,
    networking: {
      vpc,
      vpcSubnets: isolatedSubnets,
      securityGroups: [lambdaSecurityGroup],
    },
  };
}
