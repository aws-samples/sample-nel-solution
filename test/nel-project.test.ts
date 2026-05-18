import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NelAnalyticsPipeline } from '../lib/nel-project-stack';

describe('NelAnalyticsPipeline', () => {
  const app = new cdk.App({ context: { enableMonitoring: true } });
  const stack = new NelAnalyticsPipeline(app, 'TestStack');
  const template = Template.fromStack(stack);

  it('creates WAF WebACL', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  it('creates API Gateway REST API', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

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

  it('creates transform Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
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
    });
  });

  it('creates SNS topic for alarms', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('creates Glue database', () => {
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: { Name: 'nel_analytics' },
    });
  });

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
