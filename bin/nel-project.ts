#!/usr/bin/env node
/**
 * CDK app entry point for the NEL Reporting Pipeline.
 *
 * Deploys a single stack (NelAnalyticsPipeline) with all infrastructure:
 * WAF, API Gateway, Firehose, Lambda, S3, Athena, alarms, and optional monitoring.
 *
 * cdk-nag AwsSolutions checks run at synthesis time to enforce security best practices.
 * Any violations will fail `cdk synth` with actionable error messages.
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NelAnalyticsPipeline } from '../lib/nel-project-stack';

const app = new cdk.App();

const region = app.node.tryGetContext('region') ?? process.env.CDK_DEFAULT_REGION;

new NelAnalyticsPipeline(app, 'NelAnalyticsPipeline', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
