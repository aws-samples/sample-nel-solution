# NEL Pipeline Configuration Options

This project provides two feature toggles in `cdk.json` that control monitoring depth and AWS Lake Formation integration. Both default to off for minimal cost.

Toggle features in `cdk.json`:

```jsonc
"enableMonitoring": false       // default off; set true for CI rules, CW Logs widgets, Lambda structured logging
"lakeFormationEnabled": false   // default off; set true if account uses Lake Formation or Security Lake
```

## Monitoring Off (default)

- AWS Lambda publishes Amazon CloudWatch metrics (always on) but does not write to Amazon CloudWatch Logs
- Dashboard shows pipeline health widgets only (Amazon API Gateway, AWS WAF, Amazon Data Firehose metrics)
- No Contributor Insights rules

## Monitoring On

- AWS Lambda gets Amazon CloudWatch Logs permission and emits structured logs
- Dashboard adds CI widgets and LogQueryWidgets
- 11 Contributor Insights rules for error taxonomy analysis

## Lake Formation

If your account has Amazon Security Lake or AWS Lake Formation enabled, set `"lakeFormationEnabled": true` so that Amazon Athena queries work with standard IAM permissions.

## Conclusion

Start with both toggles off to minimize cost. Enable monitoring when you need deeper error analysis or structured log queries. Enable Lake Formation integration only if your account uses AWS Lake Formation or Amazon Security Lake for data governance. See [Monitoring](monitoring.md) for details on what each mode provides.
