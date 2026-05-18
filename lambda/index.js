/**
 * Firehose transform function for NEL (Network Error Logging) reports.
 *
 * Firehose invokes this function for each batch of records before delivering to S3.
 * Each record is a base64-encoded JSON NEL report from API Gateway.
 *
 * Processing per record:
 *   1. Decode base64 payload from Firehose
 *   2. Parse JSON (handles both single reports and arrays)
 *   3. Enrich with metadata (received_at timestamp, version)
 *   4. Format as newline-delimited JSON (NDJSON) for Parquet conversion
 *   5. Always publish per-error-type CloudWatch metrics
 *   6. Optionally emit structured logs (gated by ENABLE_MONITORING)
 *
 * Return codes per record:
 *   - Ok: successfully transformed, deliver to S3
 *   - ProcessingFailed: bad payload, Firehose routes to error prefix
 *
 * Environment variables:
 *   - ENABLE_MONITORING: 'true' to enable structured logging to CloudWatch Logs (default: 'false')
 *
 * @see https://w3c.github.io/network-error-logging/ NEL specification
 * @see https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html Firehose transform contract
 */
'use strict';

const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

// Initialized outside handler -- reused across invocations (Lambda INIT phase)
const cw = new CloudWatchClient();
const NAMESPACE = 'NEL/Reports';
const METRIC_NAME = 'NetworkErrorSubmissions';
const MONITORING = process.env.ENABLE_MONITORING === 'true';

exports.handler = async (event) => {
  const metrics = {};
  const output = [];

  for (const record of event.records) {
    try {
      const payload = Buffer.from(record.data, 'base64').toString('utf-8');
      const parsed = JSON.parse(payload);
      const reports = Array.isArray(parsed) ? parsed : [parsed];
      const now = new Date().toISOString();
      const lines = [];

      for (const nel of reports) {
        // Always accumulate metrics (published after loop)
        const errorType = nel.body?.type || 'unknown';
        metrics[errorType] = (metrics[errorType] || 0) + 1;

        // Structured log -- only when monitoring enabled (requires CW Logs permission)
        if (MONITORING) {
          console.log(JSON.stringify({
            event: 'nel_report',
            error_type: errorType,
            phase: nel.body?.phase || 'unknown',
            url: nel.url || '',
            method: nel.body?.method || '',
            status_code: nel.body?.status_code ?? 0,
            elapsed_time: nel.body?.elapsed_time ?? 0,
            server_ip: nel.body?.server_ip || '',
            protocol: nel.body?.protocol || '',
            sampling_fraction: nel.body?.sampling_fraction ?? 1,
            user_agent: nel.user_agent || '',
            age: nel.age ?? 0,
            received_at: now,
          }));
        }

        lines.push(JSON.stringify({
          ...nel,
          metadata: { received_at: now, version: '1.0.0' },
        }));
      }

      output.push({
        recordId: record.recordId,
        result: 'Ok',
        data: Buffer.from(lines.join('\n') + '\n').toString('base64'),
      });
    } catch (err) {
      if (MONITORING) {
        console.error('Failed to process record %s: %s', record.recordId, err.message);
      }
      output.push({
        recordId: record.recordId,
        result: 'ProcessingFailed',
        data: record.data,
      });
    }
  }

  // Always publish per-error-type metrics
  const metricData = Object.entries(metrics).map(([errorType, count]) => ({
    MetricName: METRIC_NAME,
    Dimensions: [{ Name: 'ErrorType', Value: errorType }],
    Value: count,
    Unit: 'Count',
  }));

  if (metricData.length > 0) {
    try {
      await cw.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: metricData }));
    } catch (err) {
      // Non-fatal: metrics are observability, not data path
      if (MONITORING) {
        console.error('Failed to publish metrics: %s', err.message);
      }
    }
  }

  return { records: output };
};
