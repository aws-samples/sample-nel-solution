# NEL Pipeline Utility Scripts

Utility scripts for the NEL Reporting Pipeline.

## deploy.sh

Build and deploy the CDK stack.

```bash
./scripts/deploy.sh                # interactive (shows diff, asks to confirm)
./scripts/deploy.sh --yes          # auto-approve (CI/CD)
```

Shows `enableMonitoring` status from `cdk.json` before deploying, prints stack outputs after.

## cleanup.sh

Destroy the stack and clean up all resources.

```bash
./scripts/cleanup.sh       # interactive (asks before each destructive step)
./scripts/cleanup.sh --yes # auto-approve everything including S3 bucket deletion
```

Cleans up:
1. CDK stack (AWS CloudFormation, including Amazon Athena database + table)
2. S3 bucket (optional -- empties then removes bucket)
3. Orphaned Lambda log groups

## test-nel-errors.sh

Send all 30 W3C NEL error types to the pipeline for validation.

```bash
./scripts/test-nel-errors.sh https://YOUR-API-ENDPOINT/prod/
./scripts/test-nel-errors.sh https://YOUR-API-ENDPOINT/prod/ 200  # + 200 random reports
```

## test-athena-queries.sh

Run all queries from `docs/athena-queries.md` against the deployed Athena table using the `nel-analytics` workgroup.

```bash
./scripts/test-athena-queries.sh
```

## generate-nel-data.sh

Continuously generate random NEL reports for load testing.

```bash
./scripts/generate-nel-data.sh https://YOUR-API-ENDPOINT/prod/        # 10 reports every 5s
./scripts/generate-nel-data.sh https://YOUR-API-ENDPOINT/prod/ 2 50   # 50 reports every 2s
./scripts/generate-nel-data.sh https://YOUR-API-ENDPOINT/prod/ 1 100  # 100 reports every 1s
```

Press Ctrl+C to stop and view statistics.
