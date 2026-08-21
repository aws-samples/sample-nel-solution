# Utility scripts

Utility scripts for the NEL Reporting Pipeline.

## deploy.sh

Build and deploy the CDK stack.

```bash
./scripts/deploy.sh                # interactive: show diff and ask before deployment
./scripts/deploy.sh --yes          # skip the deployment prompt
```

The script displays `enableMonitoring` and `enableWafLogging` from `cdk.json`, both of which default to `false`, and prints the deployed stack outputs.

## cleanup.sh

Destroy the stack while retaining collected reports by default.

```bash
./scripts/cleanup.sh                              # ask before destroying the stack
./scripts/cleanup.sh --yes                        # skip only the stack confirmation
./scripts/cleanup.sh --delete-bucket              # also request deletion of retained reports
./scripts/cleanup.sh --region us-east-1 --yes     # target a specific Region
```

The script:

1. Deletes the Athena workgroup so its query history does not block stack deletion.
2. Destroys the CloudFormation stack and its Glue Data Catalog resources.
3. Retains the S3 reports bucket unless `--delete-bucket` is passed.
4. Requires the exact bucket name as confirmation before deleting report data, even with `--yes`.
5. Removes Lambda log groups associated with the stack.

`--delete-bucket` permanently deletes report data and cannot be undone.

## test-nel-errors.sh

Send all 29 predefined W3C NEL error types plus the `ok` success outcome, one specific outcome, or a bounded random sample.

```bash
./scripts/test-nel-errors.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/ --all
./scripts/test-nel-errors.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/ --random 100
./scripts/test-nel-errors.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/ --type dns.failed
```

The `--random` count must be between 1 and 100.

## test-athena-queries.sh

Run 17 representative queries derived from `docs/athena-queries.md` against the deployed `nel_analytics.nel_reports` table using the `nel-analytics` workgroup.

```bash
./scripts/test-athena-queries.sh --region us-east-1
```

The Region resolves from `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, or the AWS CLI configuration. The script stops rather than silently choosing a Region if none can be resolved.

## generate-nel-data.sh

Continuously generate synthetic NEL reports for controlled load testing.

```bash
./scripts/generate-nel-data.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/        # 10 reports every 5 seconds
./scripts/generate-nel-data.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/ 2 50   # 50 reports every 2 seconds
./scripts/generate-nel-data.sh https://YOUR-API-ID.execute-api.YOUR-REGION.amazonaws.com/prod/ 1 100  # 100 reports every 1 second
```

Press Ctrl+C to stop and view statistics. Load generation can incur API Gateway, WAF, Lambda, Firehose, S3, and CloudWatch charges; keep test duration and rate bounded.
