import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export class NelAnalyticsPipeline extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Configuration (cdk.json context) ────────────────────────────
    const project = this.node.tryGetContext('project') ?? 'nel-reporting-pipeline';
    const environment = this.node.tryGetContext('environment') ?? 'dev';
    const version = this.node.tryGetContext('version') ?? '1.0.0';

    // ── Tags (centralized, inherited by all resources) ───────────────
    cdk.Tags.of(this).add('Project', project);
    cdk.Tags.of(this).add('Environment', environment);
    cdk.Tags.of(this).add('Version', version);

    // ── SNS Topic for alarm notifications ────────────────────────────
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'NEL Pipeline Alarms',
      enforceSSL: true,
    });

    // ── S3 Bucket ────────────────────────────────────────────────────
    const bucket = new s3.Bucket(this, 'NELReportsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'DeleteAfter14Days',
          expiration: cdk.Duration.days(14),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'DeleteAfter7Days',
          expiration: cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Lambda Function ────────────────────────────────────────────────
    const enableMonitoring = this.node.tryGetContext('enableMonitoring') === true;
    const lakeFormationEnabled = this.node.tryGetContext('lakeFormationEnabled') === true;

    // Custom role: always-on metrics, conditional CW Logs
    const lambdaRole = new iam.Role(this, 'TransformLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    // CloudWatch PutMetricData does not support resource-level permissions;
    // Resource:* is required. Scoped by cloudwatch:namespace condition to NEL/Reports only.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'NEL/Reports' } },
    }));
    if (enableMonitoring) {
      lambdaRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      );
    }

    const transformLambda = new lambda.Function(this, 'TransformLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      role: lambdaRole,
      environment: {
        ENABLE_MONITORING: String(enableMonitoring),
      },
      description: 'Transforms NEL reports for Firehose delivery to S3',
    });

    // ── Firehose ─────────────────────────────────────────────────────
    const firehoseRole = new iam.Role(this, 'FirehoseDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    bucket.grantPut(firehoseRole);
    bucket.grantRead(firehoseRole);
    transformLambda.grantInvoke(firehoseRole);
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/nel_analytics`,
        `arn:aws:glue:${this.region}:${this.account}:table/nel_analytics/nel_reports`,
      ],
    }));

    const deliveryStream = new firehose.CfnDeliveryStream(this, 'NELFirehose', {
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: {
        keyType: 'AWS_OWNED_CMK',
      },
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'success/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        bufferingHints: { sizeInMBs: 64, intervalInSeconds: 300 },
        compressionFormat: 'UNCOMPRESSED',
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: {
            deserializer: { openXJsonSerDe: {} },
          },
          outputFormatConfiguration: {
            serializer: { parquetSerDe: { compression: 'SNAPPY' } },
          },
          schemaConfiguration: {
            databaseName: 'nel_analytics',
            tableName: 'nel_reports',
            region: this.region,
            roleArn: firehoseRole.roleArn,
            catalogId: this.account,
          },
        },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'Lambda',
            parameters: [{ parameterName: 'LambdaArn', parameterValue: transformLambda.functionArn }],
          }],
        },
        cloudWatchLoggingOptions: {
          enabled: false,
        },
      },
    });
    deliveryStream.node.addDependency(firehoseRole);

    // ── API Gateway (regional, public) ──────────────────────────────
    const apiGatewayRole = new iam.Role(this, 'APIGatewayFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    apiGatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [deliveryStream.attrArn],
      }),
    );

    const api = new apigateway.RestApi(this, 'NELAPI', {
      restApiName: 'NEL Reporting API',
      description: 'Public regional API for receiving NEL reports. Protected by WAF.',
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: false,
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(24),
      },
    });

    // ── NEL Request Validation ─────────────────────────────────────
    // Per Reporting API spec, browsers POST an array of report objects.
    // Required per-report: age (int), type (string), url (string), body (object).
    // body required: type, sampling_fraction, elapsed_time, phase (NEL spec section 5.2 step 6).
    // body conditional: server_ip, protocol (step 7, non-dns), method, status_code, referrer (step 8, application).
    // We also accept a single report object for curl/testing convenience.
    const nelReportModel = api.addModel('NELReportModel', {
      contentType: 'application/reports+json',
      description: 'NEL report per W3C Network Error Logging and Reporting API specs',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        oneOf: [
          // Single report (testing/curl)
          {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['type', 'url', 'body'],
            properties: {
              age: { type: apigateway.JsonSchemaType.INTEGER },
              type: { type: apigateway.JsonSchemaType.STRING },
              url: { type: apigateway.JsonSchemaType.STRING },
              user_agent: { type: apigateway.JsonSchemaType.STRING },
              body: {
                type: apigateway.JsonSchemaType.OBJECT,
                required: ['type', 'sampling_fraction', 'elapsed_time', 'phase'],
                properties: {
                  type: { type: apigateway.JsonSchemaType.STRING },
                  method: { type: apigateway.JsonSchemaType.STRING },
                  status_code: { type: apigateway.JsonSchemaType.INTEGER },
                  elapsed_time: { type: apigateway.JsonSchemaType.INTEGER },
                  phase: { type: apigateway.JsonSchemaType.STRING },
                  server_ip: { type: apigateway.JsonSchemaType.STRING },
                  protocol: { type: apigateway.JsonSchemaType.STRING },
                  referrer: { type: apigateway.JsonSchemaType.STRING },
                  sampling_fraction: { type: apigateway.JsonSchemaType.NUMBER },
                },
                additionalProperties: true,
              },
            },
            additionalProperties: true,
          },
          // Array of reports (browser Reporting API)
          {
            type: apigateway.JsonSchemaType.ARRAY,
            items: {
              type: apigateway.JsonSchemaType.OBJECT,
              required: ['type', 'url', 'body'],
              properties: {
                age: { type: apigateway.JsonSchemaType.INTEGER },
                type: { type: apigateway.JsonSchemaType.STRING },
                url: { type: apigateway.JsonSchemaType.STRING },
                user_agent: { type: apigateway.JsonSchemaType.STRING },
                body: {
                  type: apigateway.JsonSchemaType.OBJECT,
                  required: ['type', 'sampling_fraction', 'elapsed_time', 'phase'],
                  properties: {
                    type: { type: apigateway.JsonSchemaType.STRING },
                  },
                  additionalProperties: true,
                },
              },
              additionalProperties: true,
            },
          },
        ],
      },
    });

    const bodyValidator = new apigateway.RequestValidator(this, 'BodyValidator', {
      restApi: api,
      validateRequestBody: true,
    });

    const firehoseIntegration = new apigateway.AwsIntegration({
      service: 'firehose',
      action: 'PutRecord',
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: apiGatewayRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/reports+json': `{
  "DeliveryStreamName": "${deliveryStream.ref}",
  "Record": {
    "Data": "$util.base64Encode($input.body)"
  }
}`,
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: { 'application/json': '{"message":"accepted"}' },
            responseParameters: {
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            },
          },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"message":"bad request"}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"message":"error"}' } },
        ],
      },
    });

    api.root.addMethod('POST', firehoseIntegration, {
      requestValidator: bodyValidator,
      requestModels: { 'application/reports+json': nelReportModel },
      methodResponses: [
        { statusCode: '200', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': true } },
        { statusCode: '400' },
        { statusCode: '500' },
      ],
    });

    // ── WAF WebACL (Positive Security Model) ──────────────────────
    // Default BLOCK -- only labelled valid requests are allowed.
    const vis = (m: string) => ({ cloudWatchMetricsEnabled: true, metricName: m, sampledRequestsEnabled: true });
    const noTx = [{ priority: 0, type: 'NONE' }];

    const webAcl = new wafv2.CfnWebACL(this, 'NELWebACL', {
      defaultAction: { block: {} },
      scope: 'REGIONAL',
      visibilityConfig: vis('NELWebACL'),
      rules: [
        // P10: Rate limit 2000 req/min per IP
        {
          name: 'RateLimitPerIP', priority: 10,
          action: { block: {} }, visibilityConfig: vis('RateLimitPerIP'),
          statement: { rateBasedStatement: { limit: 2000, evaluationWindowSec: 60, aggregateKeyType: 'IP' } },
        },
        // P20: IP Reputation -- block known DDoS sources and botnets
        {
          name: 'AWSIPReputation', priority: 20,
          overrideAction: { none: {} }, visibilityConfig: vis('AWSIPReputation'),
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesAmazonIpReputationList' } },
        },
        // P30: Known Bad Inputs -- Log4j, directory traversal, etc.
        {
          name: 'AWSKnownBadInputs', priority: 30,
          overrideAction: { none: {} }, visibilityConfig: vis('AWSKnownBadInputs'),
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' } },
        },
        // P40: Core Rule Set
        {
          name: 'AWSCoreRuleSet', priority: 40,
          overrideAction: { none: {} }, visibilityConfig: vis('AWSCoreRuleSet'),
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
        },
        // P100: Path validation -- label valid path (Count + Label)
        {
          name: 'ValidatePath', priority: 100,
          action: { count: { customRequestHandling: { insertHeaders: [{ name: 'x-nel-path-valid', value: 'true' }] } } },
          visibilityConfig: vis('ValidatePath'),
          ruleLabels: [{ name: 'nel:valid-path' }],
          statement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY',
              searchString: '/prod/', textTransformations: noTx,
            },
          },
        },
        // P110: Method validation -- label valid method (Count + Label)
        {
          name: 'ValidateMethod', priority: 110,
          action: { count: { customRequestHandling: { insertHeaders: [{ name: 'x-nel-method-valid', value: 'true' }] } } },
          visibilityConfig: vis('ValidateMethod'),
          ruleLabels: [{ name: 'nel:valid-method' }],
          statement: {
            orStatement: {
              statements: [
                { byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', searchString: 'POST', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', searchString: 'OPTIONS', textTransformations: noTx } },
              ],
            },
          },
        },
        // P120: Body validation -- label valid body when required keys present (Count + Label)
        // Envelope: "type", "url", "body" (Reporting API section 2.4)
        // Body: "phase", "elapsed_time", "sampling_fraction" (NEL spec section 5.2 step 6)
        {
          name: 'ValidateBody', priority: 120,
          action: { count: { customRequestHandling: { insertHeaders: [{ name: 'x-nel-body-valid', value: 'true' }] } } },
          visibilityConfig: vis('ValidateBody'),
          ruleLabels: [{ name: 'nel:valid-body' }],
          statement: {
            andStatement: {
              statements: [
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"type":', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"url":', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"body":', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"phase":', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"elapsed_time":', textTransformations: noTx } },
                { byteMatchStatement: { fieldToMatch: { body: { oversizeHandling: 'NO_MATCH' } }, positionalConstraint: 'CONTAINS', searchString: '"sampling_fraction":', textTransformations: noTx } },
              ],
            },
          },
        },
        // P9998: Allow CORS preflight (OPTIONS has no body, skip body validation)
        {
          name: 'AllowCORSPreflight', priority: 9998,
          action: { allow: {} }, visibilityConfig: vis('AllowCORSPreflight'),
          statement: {
            andStatement: {
              statements: [
                { labelMatchStatement: { scope: 'LABEL', key: 'nel:valid-path' } },
                { labelMatchStatement: { scope: 'LABEL', key: 'nel:valid-method' } },
                { byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', searchString: 'OPTIONS', textTransformations: noTx } },
              ],
            },
          },
        },
        // P9999: Terminating rule -- Allow only if all labels present
        {
          name: 'AllowValidRequests', priority: 9999,
          action: { allow: {} }, visibilityConfig: vis('AllowValidRequests'),
          statement: {
            andStatement: {
              statements: [
                { labelMatchStatement: { scope: 'LABEL', key: 'nel:valid-path' } },
                { labelMatchStatement: { scope: 'LABEL', key: 'nel:valid-method' } },
                { labelMatchStatement: { scope: 'LABEL', key: 'nel:valid-body' } },
              ],
            },
          },
        },
      ],
    });

    // ── WAF Association with API Gateway ────────────────────────────
    new wafv2.CfnWebACLAssociation(this, 'WAFAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    // ── CloudWatch Alarms ────────────────────────────────────────────
    const snsAction = new cloudwatch_actions.SnsAction(alarmTopic);

    // API 5xx error rate > 5% for 5 minutes
    new cloudwatch.Alarm(this, 'HighAPIErrorRateAlarm', {
      alarmName: 'NEL-API-High-Error-Rate',
      alarmDescription: 'API Gateway 5xx error rate exceeds 5%',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(requests > 0, (errors / requests) * 100, 0)',
        usingMetrics: {
          errors: api.metricServerError({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
          requests: api.metricCount({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
        },
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(snsAction);

    // Lambda error rate > 10% for 5 minutes
    new cloudwatch.Alarm(this, 'LambdaFailureAlarm', {
      alarmName: 'NEL-Lambda-High-Failure-Rate',
      alarmDescription: 'Lambda error rate exceeds 10%',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(invocations > 0, (errors / invocations) * 100, 0)',
        usingMetrics: {
          errors: transformLambda.metricErrors({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
          invocations: transformLambda.metricInvocations({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
        },
        period: cdk.Duration.minutes(1),
      }),
      threshold: 10,
      evaluationPeriods: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(snsAction);

    // Firehose delivery failure > 5% for 10 minutes
    const firehoseSuccess = new cloudwatch.Metric({
      namespace: 'AWS/Firehose',
      metricName: 'DeliveryToS3.Success',
      dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
      period: cdk.Duration.minutes(1),
      statistic: cloudwatch.Stats.SUM,
    });
    const firehoseRecords = new cloudwatch.Metric({
      namespace: 'AWS/Firehose',
      metricName: 'DeliveryToS3.Records',
      dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
      period: cdk.Duration.minutes(1),
      statistic: cloudwatch.Stats.SUM,
    });

    new cloudwatch.Alarm(this, 'FirehoseDeliveryFailureAlarm', {
      alarmName: 'NEL-Firehose-High-Failure-Rate',
      alarmDescription: 'Firehose delivery failure rate exceeds 5%',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(records > 0, ((records - success) / records) * 100, 0)',
        usingMetrics: { success: firehoseSuccess, records: firehoseRecords },
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(snsAction);

    // Data freshness > 15 minutes (metric is in seconds)
    new cloudwatch.Alarm(this, 'DataFreshnessAlarm', {
      alarmName: 'NEL-Data-Freshness-Delay',
      alarmDescription: 'Data delivery delay exceeds 15 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Firehose',
        metricName: 'DeliveryToS3.DataFreshness',
        dimensionsMap: { DeliveryStreamName: deliveryStream.ref },
        period: cdk.Duration.minutes(1),
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      threshold: 900, // 15 minutes in seconds
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(snsAction);

    // WAF blocked requests spike
    new cloudwatch.Alarm(this, 'WAFBlockedSpikeAlarm', {
      alarmName: 'NEL-WAF-Blocked-Spike',
      alarmDescription: 'WAF blocked requests exceed threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: { WebACL: 'NELWebACL', Region: this.region, Rule: 'ALL' },
        period: cdk.Duration.minutes(5),
        statistic: cloudwatch.Stats.SUM,
      }),
      threshold: 1000,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(snsAction);

    // ── Contributor Insights Widget Helper ─────────────────────────
    // The insightRule dashboard property is console-only; CloudFormation rejects it.
    // Use INSIGHT_RULE_METRIC() as metric math in a standard metric widget instead.
    class CIWidget extends cloudwatch.ConcreteWidget {
      private readonly ruleName: string;
      private readonly title: string;
      private readonly stackRegion: string;
      constructor(p: { title: string; ruleName: string; region: string; width?: number; height?: number }) {
        super(p.width ?? 8, p.height ?? 6);
        this.ruleName = p.ruleName; this.title = p.title; this.stackRegion = p.region;
      }
      toJson(): any[] {
        return [{ type: 'metric', width: this.width, height: this.height, properties: {
          metrics: [
            [{ expression: `INSIGHT_RULE_METRIC("${this.ruleName}", "Sum")`, label: 'Count', id: 'e1' }],
          ],
          view: 'timeSeries', region: this.stackRegion, period: 300, title: this.title, stat: 'Sum',
        }}];
      }
    }

    // ── Monitoring (CI rules + CW Logs widgets) ──────────────────────
    // Gated by cdk.json context "enableMonitoring" (default: false).
    // Pipeline health widgets (metrics-only) are always on.
    // CI rules and LogQueryWidgets require CW Logs and are monitoring-only.
    const monitoringWidgets: cloudwatch.IWidget[][] = [];

    if (enableMonitoring) {

    // ── Contributor Insights Rules ──────────────────────────────────
    // Fixed cost: $0.10/rule/month + $0.02/M events. No per-query charge.
    const lambdaLogGroup = transformLambda.logGroup;
    const nelLogs = [lambdaLogGroup.logGroupName];
    const nelEvent = [{ Match: '$.event', In: ['nel_report'] }];
    const failOnly = [...nelEvent, { Match: '$.error_type', NotIn: ['ok'] }];

    const ciRule = (id: string, name: string, filters: any[], keys: string[], logGroups = nelLogs) => {
      new cloudwatch.CfnInsightRule(this, id, {
        ruleName: name, ruleState: 'ENABLED',
        ruleBody: JSON.stringify({
          Schema: { Name: 'CloudWatchLogRule', Version: 1 }, AggregateOn: 'Count',
          Contribution: { Filters: filters, Keys: keys }, LogFormat: 'JSON', LogGroupNames: logGroups,
        }),
      });
      return name;
    };

    // NEL error taxonomy rules
    const rDNSTypes = ciRule('CIDNSErrors', 'NEL-DNSErrors',
      [...failOnly, { Match: '$.phase', In: ['dns'] }], ['$.error_type']);
    const rDNSDomains = ciRule('CIDNSDomains', 'NEL-DNSFailingDomains',
      [...failOnly, { Match: '$.phase', In: ['dns'] }], ['$.url']);
    const rTCPTypes = ciRule('CITCPErrors', 'NEL-TCPErrors',
      [...nelEvent, { Match: '$.error_type', In: ['tcp.timed_out','tcp.closed','tcp.reset','tcp.refused','tcp.aborted','tcp.address_invalid','tcp.address_unreachable','tcp.failed'] }],
      ['$.error_type']);
    const rTCPIPs = ciRule('CITCPServerIPs', 'NEL-TCPServerIPs',
      [...nelEvent, { Match: '$.error_type', In: ['tcp.timed_out','tcp.closed','tcp.reset','tcp.refused','tcp.aborted','tcp.address_invalid','tcp.address_unreachable','tcp.failed'] }],
      ['$.server_ip', '$.error_type']);
    const rTLSTypes = ciRule('CITLSErrors', 'NEL-TLSErrors',
      [...nelEvent, { Match: '$.error_type', In: ['tls.version_or_cipher_mismatch','tls.bad_client_auth_cert','tls.cert.name_invalid','tls.cert.date_invalid','tls.cert.authority_invalid','tls.cert.invalid','tls.cert.revoked','tls.cert.pinned_key_not_in_cert_chain','tls.protocol.error','tls.failed'] }],
      ['$.error_type']);
    const rTLSServers = ciRule('CITLSServers', 'NEL-TLSServers',
      [...nelEvent, { Match: '$.error_type', In: ['tls.version_or_cipher_mismatch','tls.bad_client_auth_cert','tls.cert.name_invalid','tls.cert.date_invalid','tls.cert.authority_invalid','tls.cert.invalid','tls.cert.revoked','tls.cert.pinned_key_not_in_cert_chain','tls.protocol.error','tls.failed'] }],
      ['$.server_ip', '$.protocol']);
    const rHTTPTypes = ciRule('CIHTTPErrors', 'NEL-HTTPErrors',
      [...failOnly, { Match: '$.phase', In: ['application'] }], ['$.error_type']);
    const rHTTPURLs = ciRule('CIHTTPURLs', 'NEL-HTTPFailingURLs',
      [...failOnly, { Match: '$.phase', In: ['application'] }], ['$.url', '$.error_type']);
    const rPhase = ciRule('CIFailuresByPhase', 'NEL-FailuresByPhase', failOnly, ['$.phase']);
    const rTopErrors = ciRule('CITopErrorTypes', 'NEL-CI-TopErrorTypes', failOnly, ['$.error_type']);
    const rAbandoned = ciRule('CIAbandonedUnknown', 'NEL-AbandonedUnknown',
      [...nelEvent, { Match: '$.error_type', In: ['abandoned', 'unknown'] }], ['$.error_type', '$.url']);

    const lg = nelLogs;
    const failFilter = 'filter event = "nel_report" and error_type != "ok"';

    monitoringWidgets.push(
      // ═══ CI: Overview ═══
      [
        new CIWidget({ region: this.region, title: 'Top Error Types', ruleName: rTopErrors, width: 8 }),
        new CIWidget({ region: this.region, title: 'Failures by Phase', ruleName: rPhase, width: 8 }),
      ],
      // ═══ CI: DNS ═══
      [
        new CIWidget({ region: this.region, title: 'DNS Errors by Type', ruleName: rDNSTypes }),
        new CIWidget({ region: this.region, title: 'DNS — Top Failing Domains', ruleName: rDNSDomains }),
      ],
      // ═══ CI: TCP ═══
      [
        new CIWidget({ region: this.region, title: 'TCP Errors by Type', ruleName: rTCPTypes }),
        new CIWidget({ region: this.region, title: 'TCP — Failing Server IPs', ruleName: rTCPIPs }),
      ],
      // ═══ CI: TLS/Certificate ═══
      [
        new CIWidget({ region: this.region, title: 'TLS Errors by Type', ruleName: rTLSTypes }),
        new CIWidget({ region: this.region, title: 'TLS — Failing Servers (IP + Protocol)', ruleName: rTLSServers }),
      ],
      // ═══ CI: HTTP / Application ═══
      [
        new CIWidget({ region: this.region, title: 'HTTP Errors by Type', ruleName: rHTTPTypes }),
        new CIWidget({ region: this.region, title: 'HTTP — Top Failing URLs', ruleName: rHTTPURLs }),
        new cloudwatch.LogQueryWidget({
          title: 'HTTP Status Codes',
          logGroupNames: lg,
          queryLines: [
            `${failFilter} and phase = "application" and status_code > 0`,
            'stats count(*) as errors by status_code, method, url',
            'sort errors desc', 'limit 15',
          ],
          width: 8, height: 6,
        }),
      ],
      // ═══ CI: Timeouts & Slow Failures ═══
      [
        new CIWidget({ region: this.region, title: 'Abandoned & Unknown', ruleName: rAbandoned }),
        new cloudwatch.LogQueryWidget({
          title: 'Slowest Failures (> 5 seconds)',
          logGroupNames: lg,
          queryLines: [
            `${failFilter} and elapsed_time > 5000`,
            'fields elapsed_time, error_type, phase, url, server_ip, protocol',
            'sort elapsed_time desc', 'limit 15',
          ],
          width: 8, height: 6,
        }),
      ],
    );

    } // end enableMonitoring

    // ── CloudWatch Dashboard (always-on pipeline health + optional CI) ──
    const period = cdk.Duration.minutes(5);

    new cloudwatch.Dashboard(this, 'NELDashboard', {
      dashboardName: 'NEL-Pipeline',
      widgets: [
        // ═══ Always-on: Pipeline Health ═══
        [
          new cloudwatch.GraphWidget({
            title: 'Error Types Over Time (CW Metrics)',
            left: [new cloudwatch.MathExpression({
              expression: `SEARCH('{NEL/Reports,ErrorType} MetricName="NetworkErrorSubmissions"', 'Sum', 300)`,
              label: '', period,
            })],
            width: 24,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Ingestion (API + WAF)',
            left: [api.metricCount({ period, statistic: cloudwatch.Stats.SUM })],
            right: [
              new cloudwatch.Metric({ namespace: 'AWS/WAFV2', metricName: 'AllowedRequests', dimensionsMap: { WebACL: 'NELWebACL', Region: this.region, Rule: 'ALL' }, period, statistic: cloudwatch.Stats.SUM }),
              new cloudwatch.Metric({ namespace: 'AWS/WAFV2', metricName: 'BlockedRequests', dimensionsMap: { WebACL: 'NELWebACL', Region: this.region, Rule: 'ALL' }, period, statistic: cloudwatch.Stats.SUM }),
            ],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Delivery (Firehose -> S3)',
            left: [firehoseRecords, firehoseSuccess],
            right: [new cloudwatch.Metric({ namespace: 'AWS/Firehose', metricName: 'DeliveryToS3.DataFreshness', dimensionsMap: { DeliveryStreamName: deliveryStream.ref }, period, statistic: cloudwatch.Stats.MAXIMUM })],
            width: 12,
          }),
        ],
        // ═══ Monitoring-only: CI + Logs widgets (empty array when off) ═══
        ...monitoringWidgets,
      ],
    });

    // ── Glue Data Catalog (database + Parquet table) ──────────────
    const glueDatabase = new glue.CfnDatabase(this, 'NelGlueDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'nel_analytics',
        description: 'NEL (Network Error Logging) analytics database',
      },
    });

    const glueTable = new glue.CfnTable(this, 'NelGlueTable', {
      catalogId: this.account,
      databaseName: 'nel_analytics',
      tableInput: {
        name: 'nel_reports',
        description: 'NEL reports in Parquet format with partition projection',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'parquet',
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2026,2099',
          'projection.year.digits': '4',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template': `s3://${bucket.bucketName}/success/year=\${year}/month=\${month}/day=\${day}/`,
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          columns: [
            { name: 'age', type: 'int' },
            { name: 'type', type: 'string' },
            { name: 'url', type: 'string' },
            { name: 'user_agent', type: 'string' },
            { name: 'body', type: 'struct<method:string,status_code:int,elapsed_time:int,phase:string,type:string,referrer:string,sampling_fraction:double,server_ip:string,protocol:string>' },
            { name: 'metadata', type: 'struct<received_at:string,version:string>' },
          ],
          location: `s3://${bucket.bucketName}/success/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
            parameters: { 'serialization.format': '1' },
          },
          compressed: true,
        },
      },
    });
    glueTable.addDependency(glueDatabase);
    deliveryStream.addDependency(glueTable);

    // ── Athena workgroup (for querying) ─────────────────────────────
    const athenaResultsLocation = `s3://${athenaResultsBucket.bucketName}/`;

    const workgroup = new cdk.CfnResource(this, 'AthenaWorkgroup', {
      type: 'AWS::Athena::WorkGroup',
      properties: {
        Name: 'nel-analytics',
        State: 'ENABLED',
        WorkGroupConfiguration: {
          ResultConfiguration: {
            OutputLocation: athenaResultsLocation,
          },
          EnforceWorkGroupConfiguration: true,
          PublishCloudWatchMetricsEnabled: false,
        },
      },
    });

    // ── Lake Formation opt-out (for accounts with Security Lake / Lake Formation) ──
    // Uses AwsSdkCall custom resource to grant IAM_ALLOWED_PRINCIPALS, avoiding the
    // requirement for CloudFormation's execution role to be a Lake Formation admin.
    if (lakeFormationEnabled) {
      const lfGrant = new cr.AwsCustomResource(this, 'LFGrantIAMAccess', {
        onCreate: {
          service: 'LakeFormation',
          action: 'batchGrantPermissions',
          parameters: {
            Entries: [
              {
                Id: 'db-grant',
                Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
                Resource: { Database: { Name: 'nel_analytics' } },
                Permissions: ['ALL'],
              },
              {
                Id: 'table-grant',
                Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
                Resource: { Table: { DatabaseName: 'nel_analytics', Name: 'nel_reports' } },
                Permissions: ['ALL'],
              },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of('nel-lf-iam-grant'),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          // Lake Formation BatchGrantPermissions/GrantPermissions are account-level APIs
          // that do not support resource-level ARN scoping. Resource:* is required per AWS docs:
          // https://docs.aws.amazon.com/lake-formation/latest/dg/
          new iam.PolicyStatement({
            actions: ['lakeformation:BatchGrantPermissions', 'lakeformation:GrantPermissions'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            actions: ['glue:GetDatabase', 'glue:GetTable'],
            resources: [
              `arn:aws:glue:${this.region}:${this.account}:catalog`,
              `arn:aws:glue:${this.region}:${this.account}:database/nel_analytics`,
              `arn:aws:glue:${this.region}:${this.account}:table/nel_analytics/nel_reports`,
            ],
          }),
        ]),
      });
      lfGrant.node.addDependency(glueTable);
      deliveryStream.addDependency(lfGrant.node.defaultChild as cdk.CfnResource);
      NagSuppressions.addResourceSuppressions(lfGrant, [
        { id: 'AwsSolutions-IAM5', reason: 'Lake Formation BatchGrantPermissions requires Resource:* per AWS docs. Glue actions scoped to nel_analytics database/table.' },
      ], true);
    }

    // ── Outputs ──────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: api.url,
      description: 'API Gateway endpoint for NEL reporting (use this in NEL headers)',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket for NEL reports',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value: athenaResultsBucket.bucketName,
      description: 'S3 bucket for Athena query results',
    });

    new cdk.CfnOutput(this, 'FirehoseStreamName', {
      value: deliveryStream.ref,
      description: 'Firehose delivery stream name',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS topic for alarm notifications - subscribe your email/Slack',
    });

    // ── CDK Nag Suppressions ─────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(bucket, [
      { id: 'AwsSolutions-S1', reason: 'NEL reports bucket; access logging would create recursion.' },
      { id: 'AwsSolutions-S10', reason: 'Ephemeral NEL data with 14-day lifecycle; versioning adds cost with no benefit.' },
    ]);

    NagSuppressions.addResourceSuppressions(athenaResultsBucket, [
      { id: 'AwsSolutions-S1', reason: 'Athena query results bucket; ephemeral data with 7-day lifecycle.' },
      { id: 'AwsSolutions-S10', reason: 'Ephemeral query results with 7-day lifecycle; versioning adds cost with no benefit.' },
    ]);

    NagSuppressions.addResourceSuppressions(lambdaRole, [
      { id: 'AwsSolutions-IAM5', reason: 'cloudwatch:PutMetricData requires Resource:* -- scoped by cloudwatch:namespace condition to NEL/Reports.', appliesTo: ['Resource::*'] },
    ], true);
    if (enableMonitoring) {
      NagSuppressions.addResourceSuppressions(lambdaRole, [
        { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole is standard for CloudWatch Logs access.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      ], true);
    }

    NagSuppressions.addResourceSuppressions(firehoseRole, [
      { id: 'AwsSolutions-IAM5', reason: 'CDK bucket.grantPut/grantRead generates s3:Abort*, GetBucket*, GetObject*, List* — scoped to the NEL bucket ARN.', appliesTo: ['Action::s3:Abort*', 'Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*'] },
      { id: 'AwsSolutions-IAM5', reason: 'Firehose writes objects with dynamic keys under the bucket prefix.', appliesTo: ['Resource::<NELReportsBucket71053822.Arn>/*'] },
      { id: 'AwsSolutions-IAM5', reason: 'CDK grantInvoke adds :* suffix for Lambda version/alias invocation.', appliesTo: ['Resource::<TransformLambda6BE149A7.Arn>:*'] },
    ], true);

    // NEL is a browser protocol — reports are sent anonymously without auth tokens.
    // WAF provides the access control layer (positive security model + rate limiting).
    NagSuppressions.addResourceSuppressions(
      api.root.node.findChild('POST').node.defaultChild!,
      [
        { id: 'AwsSolutions-APIG4', reason: 'NEL reports are sent by browsers anonymously per W3C spec. WAF provides access control.' },
        { id: 'AwsSolutions-COG4', reason: 'NEL reports are sent by browsers anonymously per W3C spec. Cognito auth would break the protocol.' },
      ],
    );

    NagSuppressions.addResourceSuppressions(api, [
      { id: 'AwsSolutions-APIG2', reason: 'Request body validation is configured at method level via BodyValidator, not at API level.' },
    ]);
    NagSuppressions.addResourceSuppressions(api.deploymentStage, [
      { id: 'AwsSolutions-APIG6', reason: 'Execution logging disabled to reduce cost and avoid account-level CloudWatch Logs role dependency.' },
      { id: 'AwsSolutions-APIG1', reason: 'Access logging is gated by enableMonitoring context flag. Default off to minimize cost for sample project.' },
    ]);

    // CDK creates a LogRetention custom resource Lambda when logGroup is referenced in dashboard
    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK LogRetention custom resource uses AWSLambdaBasicExecutionRole.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-IAM5', reason: 'CDK LogRetention custom resource requires logs:* for PutRetentionPolicy/DeleteRetentionPolicy.', appliesTo: ['Resource::*'] },
      { id: 'AwsSolutions-L1', reason: 'AwsCustomResource Lambda runtime is managed by CDK, not user-configurable.' },
    ]);

  }
}
