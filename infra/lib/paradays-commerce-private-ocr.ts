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

/** CLI context is a string, while programmatic context can be a boolean. */
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
 * Opt-in requires context paddleOcrImageUri containing a tested, published ECR
 * URI: ACCOUNT.dkr.ecr.REGION.amazonaws.com/REPOSITORY@sha256:64-lowercase-hex.
 * The repository must be in this stack's account and region. Unresolved stack
 * environments fail closed; provide a concrete deployment environment first.
 * Importing the repository creates no registry and changes no bootstrap policy.
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
  // CDK binds an exact @sha256 image and grants only ECR pull permissions to
  // the task execution role; repository access is scoped to this imported repo.
  return ecs.ContainerImage.fromEcrRepository(repository, match[5]);
}

/**
 * Provide trusted AWS HTTPS without requiring an owned DNS domain. The REST
 * endpoint is PRIVATE and the HTTP backend is reachable only through its VPC
 * link. Model artifacts are built into the image; no runtime internet route
 * exists. Opt-out creates none of these resources and preserves the old secret.
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
  // Gateway endpoints use AWS public service prefixes, but isolated subnet
  // route tables have no default internet/NAT route. HTTPS can leave only via
  // the listed AWS endpoints; OCR model downloads cannot run in this VPC.
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
    // API Gateway VPC link traffic arrives through AWS PrivateLink. The NLB
    // has no direct inbound rule, and worker ingress still requires this SG.
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
