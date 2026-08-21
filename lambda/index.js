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
 *   5. Publish bounded per-error-type CloudWatch metrics
 *   6. Optionally emit structured logs (gated by ENABLE_MONITORING)
 *
 * Return codes per record:
 *   - Ok: successfully transformed, deliver to S3
 *   - ProcessingFailed: bad payload, Firehose routes to error prefix
 *
 * Environment variables:
 *   - ENABLE_MONITORING: 'true' to enable structured logging to CloudWatch Logs (default: 'false')
 *   - APP_VERSION: version written into each record's metadata
 *
 * @see https://w3c.github.io/network-error-logging/ NEL specification
 * @see https://docs.aws.amazon.com/firehose/latest/dev/data-transformation.html Firehose transform contract
 */
'use strict';

const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

const NAMESPACE = 'NEL/Reports';
const METRIC_NAME = 'NetworkErrorSubmissions';
const MONITORING = process.env.ENABLE_MONITORING === 'true';

// W3C NEL section 6 defines these values and permits user agents to add custom
// types. Raw custom values are retained in Parquet, but custom metric values are
// collapsed into "other" to prevent unbounded CloudWatch metric cardinality.
const PREDEFINED_ERROR_TYPES = new Set([
  'dns.unreachable',
  'dns.name_not_resolved',
  'dns.failed',
  'dns.address_changed',
  'tcp.timed_out',
  'tcp.closed',
  'tcp.reset',
  'tcp.refused',
  'tcp.aborted',
  'tcp.address_invalid',
  'tcp.address_unreachable',
  'tcp.failed',
  'tls.version_or_cipher_mismatch',
  'tls.bad_client_auth_cert',
  'tls.cert.name_invalid',
  'tls.cert.date_invalid',
  'tls.cert.authority_invalid',
  'tls.cert.invalid',
  'tls.cert.revoked',
  'tls.cert.pinned_key_not_in_cert_chain',
  'tls.protocol.error',
  'tls.failed',
  'http.error',
  'http.protocol.error',
  'http.response.invalid',
  'http.response.redirect_loop',
  'http.failed',
  'abandoned',
  'unknown',
  'ok',
]);

function metricErrorType(errorType) {
  return PREDEFINED_ERROR_TYPES.has(errorType) ? errorType : 'other';
}

function createHandler({
  cloudWatchClient = new CloudWatchClient(),
  now = () => new Date().toISOString(),
  appVersion = process.env.APP_VERSION || '1.0.0',
  monitoring = MONITORING,
} = {}) {
  return async (event) => {
    const metrics = new Map();
    const output = [];

    for (const record of event.records) {
      try {
        const payload = Buffer.from(record.data, 'base64').toString('utf-8');
        const parsed = JSON.parse(payload);
        const reports = Array.isArray(parsed) ? parsed : [parsed];
        const receivedAt = now();
        const lines = [];

        for (const nel of reports) {
          const rawErrorType = nel.body?.type || 'unknown';
          const boundedErrorType = metricErrorType(rawErrorType);
          metrics.set(boundedErrorType, (metrics.get(boundedErrorType) || 0) + 1);

          if (monitoring) {
            console.log(JSON.stringify({
              event: 'nel_report',
              error_type: rawErrorType,
              metric_error_type: boundedErrorType,
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
              received_at: receivedAt,
            }));
          }

          lines.push(JSON.stringify({
            ...nel,
            metadata: { received_at: receivedAt, version: appVersion },
          }));
        }

        output.push({
          recordId: record.recordId,
          result: 'Ok',
          data: Buffer.from(`${lines.join('\n')}\n`).toString('base64'),
        });
      } catch (err) {
        if (monitoring) {
          console.error('Failed to process record %s: %s', record.recordId, err.message);
        }
        output.push({
          recordId: record.recordId,
          result: 'ProcessingFailed',
          data: record.data,
        });
      }
    }

    const metricData = Array.from(metrics, ([errorType, count]) => ({
      MetricName: METRIC_NAME,
      Dimensions: [{ Name: 'ErrorType', Value: errorType }],
      Value: count,
      Unit: 'Count',
    }));

    if (metricData.length > 0) {
      try {
        await cloudWatchClient.send(new PutMetricDataCommand({
          Namespace: NAMESPACE,
          MetricData: metricData,
        }));
      } catch (err) {
        // Metrics are observability only and must not fail the delivery path.
        if (monitoring) {
          console.error('Failed to publish metrics: %s', err.message);
        }
      }
    }

    return { records: output };
  };
}

exports.metricErrorType = metricErrorType;
exports.createHandler = createHandler;
exports.handler = createHandler();
