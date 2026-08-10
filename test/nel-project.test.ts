/**
 * CDK assertion tests for the NEL Reporting Pipeline stack.
 *
 * These tests synthesize the NelAnalyticsPipeline stack into a CloudFormation
 * template and assert that the resources the pipeline depends on exist with the
 * expected properties. They use node:test and the aws-cdk-lib assertions module,
 * so they run without deploying anything and are safe and fast for CI.
 *
 * The stack is synthesized with enableMonitoring=true so the optional
 * monitoring resources (Contributor Insights rules and log widgets) are
 * exercised alongside the always-on pipeline resources.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NelAnalyticsPipeline } from '../lib/nel-project-stack';

describe('NelAnalyticsPipeline', () => {
  // Synthesize the stack once and reuse the template across all assertions.
  const app = new cdk.App({ context: { enableMonitoring: true } });
  const stack = new NelAnalyticsPipeline(app, 'TestStack');
  const template = Template.fromStack(stack);

  // WAF WebACL is the access-control layer for the public ingress endpoint.
  it('creates WAF WebACL', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  // Regional REST API that receives the browser NEL POST requests.
  it('creates API Gateway REST API', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  // Firehose must convert records to Parquet (SNAPPY) so Athena can run
  // efficient columnar queries over the stored reports.
  it('creates Firehose delivery stream with Parquet format conversion', () => {
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      ExtendedS3DestinationConfiguration: {
        CompressionFormat: 'UNCOMPRESSED',
        DataFormatConversionConfiguration: {
          Enabled: true,
          OutputFormatConfiguration: {
            Serializer: { ParquetSerDe: { Compression: 'SNAPPY' } },
          },
        },
      },
    });
  });

  // Transform Lambda runs on the pinned Node.js runtime.
  it('creates transform Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  // Reports bucket must encrypt at rest and block all public access.
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
    });
  });

  // SNS topic fans out alarm notifications to subscribers.
  it('creates SNS topic for alarms', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  // Glue database backs the Athena catalog for the reports.
  it('creates Glue database', () => {
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: { Name: 'nel_analytics' },
    });
  });

  // Glue table defines the Parquet schema and partition projection that let
  // Athena query by year/month/day without running a crawler.
  it('creates Glue table with Parquet format and partition projection', () => {
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
});
