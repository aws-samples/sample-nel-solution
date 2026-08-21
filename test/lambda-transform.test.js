'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, metricErrorType } = require('../lambda/index.js');

const FIXED_TIME = '2026-08-20T06:30:00.000Z';

function firehoseRecord(recordId, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { recordId, data: Buffer.from(text).toString('base64') };
}

function recordingCloudWatch() {
  const inputs = [];
  return {
    inputs,
    client: {
      async send(command) {
        inputs.push(command.input);
        return {};
      },
    },
  };
}

function decodeLines(record) {
  return Buffer.from(record.data, 'base64')
    .toString('utf-8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('NEL Firehose transform', () => {
  it('transforms and enriches a single report', async () => {
    const cloudWatch = recordingCloudWatch();
    const handler = createHandler({
      cloudWatchClient: cloudWatch.client,
      now: () => FIXED_TIME,
      appVersion: '2.0.0-test',
      monitoring: false,
    });
    const report = {
      type: 'network-error',
      url: 'https://example.com/',
      body: {
        type: 'dns.name_not_resolved',
        phase: 'dns',
        elapsed_time: 12,
        sampling_fraction: 1,
      },
    };

    const result = await handler({ records: [firehoseRecord('record-1', report)] });

    assert.equal(result.records[0].result, 'Ok');
    assert.deepEqual(decodeLines(result.records[0]), [{
      ...report,
      metadata: { received_at: FIXED_TIME, version: '2.0.0-test' },
    }]);
    assert.equal(cloudWatch.inputs.length, 1);
    assert.deepEqual(cloudWatch.inputs[0].MetricData, [{
      MetricName: 'NetworkErrorSubmissions',
      Dimensions: [{ Name: 'ErrorType', Value: 'dns.name_not_resolved' }],
      Value: 1,
      Unit: 'Count',
    }]);
  });

  it('expands browser arrays to NDJSON and aggregates metrics', async () => {
    const cloudWatch = recordingCloudWatch();
    const handler = createHandler({
      cloudWatchClient: cloudWatch.client,
      now: () => FIXED_TIME,
      monitoring: false,
    });
    const reports = [
      { type: 'network-error', url: 'https://a.example/', body: { type: 'tcp.reset' } },
      { type: 'network-error', url: 'https://b.example/', body: { type: 'tcp.reset' } },
      { type: 'network-error', url: 'https://c.example/', body: { type: 'quic.vendor_detail' } },
    ];

    const result = await handler({ records: [firehoseRecord('record-array', reports)] });
    const transformed = decodeLines(result.records[0]);

    assert.equal(transformed.length, 3);
    assert.equal(transformed[2].body.type, 'quic.vendor_detail');
    const metricCounts = Object.fromEntries(cloudWatch.inputs[0].MetricData.map((metric) => [
      metric.Dimensions[0].Value,
      metric.Value,
    ]));
    assert.deepEqual(metricCounts, { 'tcp.reset': 2, other: 1 });
  });

  it('maps all non-standard error types to one bounded metric dimension', () => {
    assert.equal(metricErrorType('ok'), 'ok');
    assert.equal(metricErrorType('tls.failed'), 'tls.failed');
    assert.equal(metricErrorType('vendor.one'), 'other');
    assert.equal(metricErrorType('vendor.two'), 'other');
    assert.equal(metricErrorType(''), 'other');
  });

  it('emits the structured monitoring fields consumed by Contributor Insights', async () => {
    const cloudWatch = recordingCloudWatch();
    const messages = [];
    const originalConsoleLog = console.log;
    console.log = (message) => messages.push(message);

    try {
      const handler = createHandler({
        cloudWatchClient: cloudWatch.client,
        now: () => FIXED_TIME,
        monitoring: true,
      });
      await handler({ records: [firehoseRecord('record-monitoring', {
        age: 7,
        type: 'network-error',
        url: 'https://example.com/resource',
        user_agent: 'test-agent',
        body: {
          type: 'tcp.reset',
          phase: 'connection',
          method: 'GET',
          status_code: 0,
          elapsed_time: 125,
          server_ip: '192.0.2.10',
          protocol: 'h2',
          sampling_fraction: 0.5,
        },
      })] });
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(messages.length, 1);
    assert.deepEqual(JSON.parse(messages[0]), {
      event: 'nel_report',
      error_type: 'tcp.reset',
      metric_error_type: 'tcp.reset',
      phase: 'connection',
      url: 'https://example.com/resource',
      method: 'GET',
      status_code: 0,
      elapsed_time: 125,
      server_ip: '192.0.2.10',
      protocol: 'h2',
      sampling_fraction: 0.5,
      user_agent: 'test-agent',
      age: 7,
      received_at: FIXED_TIME,
    });
  });

  it('routes malformed JSON to Firehose processing failure without metrics', async () => {
    const cloudWatch = recordingCloudWatch();
    const handler = createHandler({
      cloudWatchClient: cloudWatch.client,
      now: () => FIXED_TIME,
      monitoring: false,
    });
    const input = firehoseRecord('bad-record', '{not-json');

    const result = await handler({ records: [input] });

    assert.deepEqual(result.records, [{
      recordId: 'bad-record',
      result: 'ProcessingFailed',
      data: input.data,
    }]);
    assert.equal(cloudWatch.inputs.length, 0);
  });

  it('uses the predefined unknown metric when the report body is absent', async () => {
    const cloudWatch = recordingCloudWatch();
    const handler = createHandler({
      cloudWatchClient: cloudWatch.client,
      now: () => FIXED_TIME,
      monitoring: false,
    });

    await handler({ records: [firehoseRecord('missing-body', { type: 'network-error' })] });

    assert.equal(
      cloudWatch.inputs[0].MetricData[0].Dimensions[0].Value,
      'unknown',
    );
  });

  it('keeps successful data delivery non-fatal when CloudWatch rejects metrics', async () => {
    const handler = createHandler({
      cloudWatchClient: { async send() { throw new Error('metric failure'); } },
      now: () => FIXED_TIME,
      monitoring: false,
    });

    const result = await handler({
      records: [firehoseRecord('record-1', {
        type: 'network-error',
        body: { type: 'http.failed' },
      })],
    });

    assert.equal(result.records[0].result, 'Ok');
  });
});
