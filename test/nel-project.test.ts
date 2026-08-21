/**
 * CDK assertion tests for the NEL Reporting Pipeline stack.
 *
 * These tests synthesize the stack into CloudFormation and verify security,
 * format-conversion, throttling, and optional-feature behavior without deploying.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NelAnalyticsPipeline } from '../lib/nel-project-stack';

function synthTemplate(context: Record<string, unknown> = {}): Template {
  const app = new cdk.App({ context });
  const stack = new NelAnalyticsPipeline(app, `TestStack${Math.random().toString(36).slice(2)}`);
  return Template.fromStack(stack);
}

describe('NelAnalyticsPipeline', () => {
  const template = synthTemplate({ enableMonitoring: true });

  it('creates WAF WebACL with the per-IP five-minute rate limit', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitPerIP',
          Statement: {
            RateBasedStatement: {
              AggregateKeyType: 'IP',
              EvaluationWindowSec: 300,
              Limit: 1000,
            },
          },
        }),
      ]),
    });
  });

  it('creates API Gateway with the aggregate stage throttle', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ThrottlingBurstLimit: 200,
          ThrottlingRateLimit: 100,
        }),
      ]),
    });
  });

  it('creates Firehose delivery stream with Lambda and Parquet conversion', () => {
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      ExtendedS3DestinationConfiguration: {
        CompressionFormat: 'UNCOMPRESSED',
        DataFormatConversionConfiguration: {
          Enabled: true,
          OutputFormatConfiguration: {
            Serializer: { ParquetSerDe: { Compression: 'SNAPPY' } },
          },
        },
        ProcessingConfiguration: {
          Enabled: true,
          Processors: Match.arrayWith([
            Match.objectLike({ Type: 'Lambda' }),
          ]),
        },
      },
    });
  });

  it('creates the transform Lambda with version metadata configuration', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          APP_VERSION: '1.0.0',
          ENABLE_MONITORING: 'true',
        }),
      },
    });
  });

  it('creates S3 bucket with encryption and public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      Tags: Match.arrayWith([
        { Key: 'CostCenter', Value: 'sample' },
        { Key: 'Environment', Value: 'dev' },
        { Key: 'Owner', Value: 'sample-maintainer' },
        { Key: 'Project', Value: 'nel-reporting-pipeline' },
        { Key: 'Version', Value: '1.0.0' },
      ]),
    });
  });

  it('creates SNS, Glue, and Athena resources', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: { Name: 'nel_analytics' },
    });
    template.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: 'nel_analytics',
      TableInput: {
        Name: 'nel_reports',
        TableType: 'EXTERNAL_TABLE',
        Parameters: {
          'classification': 'parquet',
          'projection.enabled': 'true',
        },
        StorageDescriptor: {
          InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          OutputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          SerdeInfo: {
            SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
        },
      },
    });
  });

  it('keeps optional Lambda and WAF logging off by default', () => {
    const defaultTemplate = synthTemplate();
    defaultTemplate.resourceCountIs('AWS::CloudWatch::InsightRule', 0);
    defaultTemplate.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 0);
    defaultTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ ENABLE_MONITORING: 'false' }),
      },
    });
  });

  it('accepts CLI string booleans and enables blocked-only WAF logging', () => {
    const enabledTemplate = synthTemplate({
      enableMonitoring: 'true',
      enableWafLogging: 'true',
    });
    enabledTemplate.resourceCountIs('AWS::CloudWatch::InsightRule', 11);
    enabledTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'aws-waf-logs-nel-reporting',
      RetentionInDays: 7,
    });
    enabledTemplate.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      LoggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [{
          Behavior: 'KEEP',
          Conditions: [{ ActionCondition: { Action: 'BLOCK' } }],
          Requirement: 'MEETS_ANY',
        }],
      },
    });
  });

  it('rejects invalid boolean context values', () => {
    const app = new cdk.App({ context: { enableMonitoring: 'yes' } });
    assert.throws(
      () => new NelAnalyticsPipeline(app, 'InvalidFlagStack'),
      /enableMonitoring must be true or false/,
    );
  });

  it('does not synthesize the removed Lake Formation compatibility grant', () => {
    const rendered = JSON.stringify(template.toJSON());
    assert.equal(rendered.includes('IAM_ALLOWED_PRINCIPALS'), false);
    assert.equal(rendered.includes('lakeformation:GrantPermissions'), false);
    assert.equal(rendered.includes('arn:aws:glue:'), false);
  });

  it('grants API Gateway only the Firehose action it invokes', () => {
    const rendered = JSON.stringify(template.toJSON());
    assert.equal(rendered.includes('firehose:PutRecordBatch'), false);
    assert.equal(rendered.includes('firehose:PutRecord'), true);
  });
});
