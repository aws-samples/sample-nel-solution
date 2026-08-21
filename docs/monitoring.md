# Monitoring

The NEL Reporting Pipeline always deploys operational metrics, alarms, and a dashboard. Detailed Lambda and AWS WAF request logs are separate opt-in features because they add cost and can collect sensitive request metadata.

## Always-on telemetry

| Alarm | Condition |
|---|---|
| `NEL-API-High-Error-Rate` | API Gateway 5xx responses exceed 5% for 5 minutes |
| `NEL-Lambda-High-Failure-Rate` | Lambda errors exceed 10% for 5 minutes |
| `NEL-Firehose-High-Failure-Rate` | Delivery failures exceed 5% for 10 minutes |
| `NEL-Data-Freshness-Delay` | Delivery delay exceeds 15 minutes |
| `NEL-WAF-Blocked-Spike` | Blocked requests exceed 1,000 in 5 minutes |

The `NEL-Pipeline` dashboard includes:

- Bounded custom NEL error metrics. W3C predefined error types retain their names; extension types are aggregated as `other`.
- API Gateway request counts and AWS WAF allowed/blocked counts.
- Firehose delivery records, success, and data freshness.

These resources are not free by definition. CloudWatch custom metrics, alarms, dashboards, API calls, and SNS delivery can incur charges. Review the current [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) and [Amazon SNS pricing](https://aws.amazon.com/sns/pricing/) for the deployment Region.

## Optional Lambda monitoring

Set `enableMonitoring=true` in `cdk.json` or pass `-c enableMonitoring=true` to add:

- Lambda CloudWatch Logs permissions and structured report logs.
- 11 Contributor Insights rules for DNS, TCP, TLS, HTTP, phase, URL, and server analysis.
- Contributor Insights and Logs Insights widgets on the dashboard.

Structured logs can include full URLs, referrers, user agents, server IP addresses, methods, status codes, and timings. Query strings can contain sensitive values. Keep this feature off unless those fields, retention, access, privacy obligations, and CloudWatch Logs/Contributor Insights charges have been reviewed.

## Optional WAF logging

Set `enableWafLogging=true` to create a seven-day CloudWatch Logs group named `aws-waf-logs-nel-reporting`. The logging filter drops allowed requests and keeps only requests whose final AWS WAF action is `BLOCK`.

Blocked-only logging lowers volume and supports abuse investigation, but it is still billable and may include URI, header, client IP, and rule-match metadata. It is independent of Lambda monitoring, and both features default to off.

## Subscribe to alerts

Use the `AlarmTopicArn` stack output to add an Amazon SNS subscription. Confirm the subscription before expecting notifications.

## Cost controls

- Keep `success_fraction` low for busy sites; successful NEL reports can dominate ingestion volume.
- Keep Lambda and WAF logging off until needed.
- Use the default seven-day WAF log retention and 14-day report lifecycle unless requirements justify longer retention.
- Bound load tests by request count and duration.
- Consider AWS Budgets and Cost Anomaly Detection before sustained testing.

See [Configuration](configuration.md) for toggles and [Athena Queries](athena-queries.md) for historical analysis without enabling detailed Lambda logs.
