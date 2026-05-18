#!/usr/bin/env bash
# Destroy the NEL Reporting Pipeline and clean up all resources.
# Usage: ./scripts/cleanup.sh [--yes]
set -euo pipefail

cd "$(dirname "$0")/.."

STACK_NAME="NelAnalyticsPipeline"
REGION="${AWS_DEFAULT_REGION:-eu-north-1}"
AUTO_APPROVE=false
[ "${1:-}" = "--yes" ] && AUTO_APPROVE=true

# Get bucket name before destroying stack
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text 2>/dev/null || echo "")

echo "==> This will DESTROY:"
echo "    - CDK stack: ${STACK_NAME} (includes Athena database + table)"
[ -n "$BUCKET" ] && echo "    - S3 bucket: ${BUCKET} (optional, retained by default)"
echo ""
echo "    WARNING: S3 bucket has RETAIN policy -- CDK destroy will NOT delete it."
echo ""

if [ "$AUTO_APPROVE" != true ]; then
  read -rp "Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# 1. Pre-destroy: force-delete Athena workgroup (has query history that blocks CloudFormation delete)
echo ""
echo "==> Pre-destroy: clearing Athena workgroup query history..."
aws athena delete-work-group --work-group nel-analytics --recursive-delete-option --region "$REGION" 2>/dev/null && \
  echo "  Workgroup deleted." || \
  echo "  Workgroup not found or already deleted -- skipping."

# 2. Destroy CDK stack
echo ""
echo "==> Destroying CDK stack..."
if [ "$AUTO_APPROVE" = true ]; then
  npx cdk destroy "$STACK_NAME" --force
else
  npx cdk destroy "$STACK_NAME"
fi

# 3. Clean up Glue database/table (custom resource has no onDelete, so these survive cdk destroy)
echo ""
echo "==> Cleaning up Athena/Glue catalog..."
aws glue delete-table --database-name nel_analytics --name nel_reports --region "$REGION" 2>/dev/null && \
  echo "  Deleted table nel_analytics.nel_reports" || echo "  Table not found -- skipping."
aws glue delete-database --name nel_analytics --region "$REGION" 2>/dev/null && \
  echo "  Deleted database nel_analytics" || echo "  Database not found -- skipping."

# 4. Optionally empty and delete retained S3 bucket
if [ -n "$BUCKET" ]; then
  echo ""
  if [ "$AUTO_APPROVE" = true ]; then
    DELETE_BUCKET=true
  else
    echo "  WARNING: This will PERMANENTLY DELETE all data. This action cannot be undone."
    read -rp "Also delete S3 bucket ${BUCKET} and ALL data? [y/N] " del
    DELETE_BUCKET=false
    [[ "$del" =~ ^[Yy]$ ]] && DELETE_BUCKET=true
  fi

  if [ "$DELETE_BUCKET" = true ]; then
    echo "==> Emptying and deleting bucket..."
    aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION"
    aws s3 rb "s3://${BUCKET}" --region "$REGION"
    echo "  Bucket deleted."
  else
    echo "  Bucket retained: ${BUCKET}"
    echo "  WARNING: Retained bucket will continue to incur S3 storage costs."
    echo "  To delete later: aws s3 rb s3://${BUCKET} --force"
  fi
fi

# 5. Clean up orphaned log groups
echo ""
echo "==> Cleaning up orphaned log groups..."
for prefix in "/aws/lambda/NelAnalyticsPipeline" "aws-waf-logs-nel" "NelAnalyticsPipeline"; do
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "$prefix" \
    --region "$REGION" --query 'logGroups[*].logGroupName' --output text 2>/dev/null); do
    echo "  Deleting $lg"
    aws logs delete-log-group --log-group-name "$lg" --region "$REGION" 2>/dev/null || true
  done
done

echo ""
echo "Cleanup complete."
