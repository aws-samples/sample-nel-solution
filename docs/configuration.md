# Configuration

The stack reads deployment settings from the `context` object in `cdk.json`. Optional logging is disabled by default to minimize sample cost and avoid collecting request metadata unless explicitly needed.

## Context values

```jsonc
{
  "enableMonitoring": false,
  "enableWafLogging": false,
  "project": "nel-reporting-pipeline",
  "environment": "dev",
  "version": "1.0.0",
  "owner": "sample-maintainer",
  "costCenter": "sample"
}
```

Replace the sample `owner` and `costCenter` values with identifiers from your organization before deployment.

| Setting | Default | Effect |
|---|---:|---|
| `enableMonitoring` | `false` | Enables Lambda CloudWatch Logs permissions, structured report logs, 11 Contributor Insights rules, and log-query dashboard widgets. |
| `enableWafLogging` | `false` | Creates a seven-day CloudWatch Logs group and keeps only AWS WAF requests whose final action is `BLOCK`. |
| `project` | `nel-reporting-pipeline` | Value for the inherited `Project` resource tag. |
| `environment` | `dev` | Value for the inherited `Environment` resource tag. |
| `version` | `1.0.0` | Value for the inherited `Version` tag and the transform metadata written to Parquet. |
| `owner` | `sample-maintainer` | Value for the inherited `Owner` resource tag. Replace this sample value before deployment. |
| `costCenter` | `sample` | Value for the inherited `CostCenter` resource tag. Replace this sample value before deployment. |

Boolean context values accept JSON booleans and the CDK CLI strings `true` and `false`. Other values fail synthesis rather than silently disabling a feature.

Examples:

```bash
# Default: no Lambda structured logs and no WAF request logs
npx cdk synth

# Temporarily enable Lambda structured logs and Contributor Insights
npx cdk synth -c enableMonitoring=true

# Temporarily enable blocked-only WAF request logging
npx cdk synth -c enableWafLogging=true
```

## Monitoring disabled (default)

- Lambda still publishes the bounded `NEL/Reports` custom metrics used by the dashboard.
- AWS service metrics, alarms, and the pipeline dashboard remain enabled.
- Lambda structured report logging and Contributor Insights are absent.
- AWS WAF request logging is absent.
- API Gateway execution/access logging and Firehose delivery logging remain disabled.

CloudWatch custom metrics, alarms, dashboards, and other deployed services can still incur charges even when both optional logging flags are off.

## Monitoring enabled

`enableMonitoring=true` adds detailed report telemetry that may include URLs, referrers, user agents, server IP addresses, methods, status codes, and timings. Enable it only after reviewing data classification, access, retention, privacy, and cost requirements.

## WAF logging enabled

`enableWafLogging=true` records only blocked requests to `aws-waf-logs-nel-reporting` with seven-day retention. This filter reduces volume compared with logging every request, but request metadata can still be sensitive and CloudWatch Logs ingestion and storage are billable.

## Lake Formation

The sample does not automatically grant `IAMAllowedPrincipals` permissions. Lake Formation grants that principal `Super` permission for IAM compatibility, which effectively places the affected Data Catalog resources back under IAM-only control and can undermine fine-grained Lake Formation governance.

The default deployment uses Glue, S3, Firehose, and Athena IAM permissions. If your account enforces Lake Formation permissions, integrate the database, table, data location, and query principals with your organization’s Lake Formation model. AWS recommends hybrid access mode for incremental migration rather than applying a broad compatibility grant from this sample.

See [Architecture decisions](architecture-decisions.md) for the trade-off analysis and source links.
