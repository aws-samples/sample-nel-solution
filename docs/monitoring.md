# NEL Pipeline Monitoring and Alarms

The NEL Reporting Pipeline provides two monitoring modes. Always-on alarms and a dashboard track pipeline health using Amazon CloudWatch metrics with no additional cost. Optional monitoring adds AWS Lambda structured logging and Contributor Insights rules for deeper error analysis.

## Always-on Alarms

| Alarm | Condition |
|-------|-----------|
| NEL-API-High-Error-Rate | 5xx > 5% for 5 min |
| NEL-Lambda-High-Failure-Rate | Errors > 10% for 5 min |
| NEL-Firehose-High-Failure-Rate | Delivery failures > 5% for 10 min |
| NEL-Data-Freshness-Delay | Delay > 15 min |
| NEL-WAF-Blocked-Spike | Blocked > 1000 in 5 min |

## Always-on Dashboard

The `NEL-Pipeline` dashboard includes pipeline health widgets using Amazon CloudWatch Metrics (no Amazon CloudWatch Logs dependency):
- Error types over time (from custom CloudWatch metrics)
- Amazon API Gateway + AWS WAF ingestion rates
- Amazon Data Firehose delivery success + data freshness

## Optional Monitoring (`enableMonitoring: true`)

When enabled:
- AWS Lambda structured logging to Amazon CloudWatch Logs
- 11 Contributor Insights rules (DNS/TCP/TLS/HTTP errors, failing domains/IPs/URLs)
- Additional CI + LogQuery widgets on the dashboard

## Subscribe to Alerts

Use the `AlarmTopicArn` output from `cdk deploy` to subscribe via email, Slack, or PagerDuty.

## Conclusion

The always-on alarms and dashboard provide pipeline health visibility at no additional cost. Enable optional monitoring when you need to investigate specific error patterns or identify failing domains and server IPs. See [Configuration](configuration.md) for details on enabling monitoring, and [Athena Queries](athena-queries.md) for historical analysis.
