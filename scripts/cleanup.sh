#!/usr/bin/env bash
# Destroy the NEL Reporting Pipeline and clean up its resources.
#
# By default this removes the AWS CloudFormation stack, pre-deletes the Amazon
# Athena workgroup whose query history can block deletion, and defensively
# removes any remaining AWS Glue catalog objects. The Amazon S3 reports bucket
# has a RETAIN removal policy, so it is NOT deleted unless you explicitly pass
# --delete-bucket and confirm. This prevents accidental, unrecoverable data loss.
#
# Usage:
#   ./scripts/cleanup.sh [--yes] [--delete-bucket] [--region REGION]
#
#   --yes            Skip the confirmation prompt for destroying the stack.
#   --delete-bucket  Also delete the retained S3 reports bucket and all data.
#                    Always requires a typed confirmation, even with --yes.
#   --region REGION  AWS Region to target. Defaults to the AWS CLI configured
#                    Region (AWS_REGION, then AWS_DEFAULT_REGION, then
#                    'aws configure get region').
set -euo pipefail

cd "$(dirname "$0")/.."

STACK_NAME="NelAnalyticsPipeline"
AUTO_APPROVE=false
DELETE_BUCKET_OPT=false
REGION=""

# Parse arguments (order-independent).
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) AUTO_APPROVE=true ;;
    --delete-bucket) DELETE_BUCKET_OPT=true ;;
    --region)
      if [ $# -ge 2 ]; then REGION="$2"; shift; else echo "ERROR: --region needs a value" >&2; exit 2; fi
      ;;
    --region=*) REGION="${1#*=}" ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve the Region explicitly. Fail loudly rather than defaulting to an
# arbitrary Region and silently cleaning up nothing.
if [ -z "$REGION" ]; then
  REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
fi
if [ -z "$REGION" ]; then
  echo "ERROR: no AWS Region resolved. Pass --region REGION or configure the AWS CLI." >&2
  exit 1
fi
echo "==> Target Region: ${REGION}"

# Confirm the stack exists in this Region before doing anything destructive.
# A missing stack here means the wrong Region or stack name, so stop.
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "ERROR: stack '${STACK_NAME}' not found in Region '${REGION}'." >&2
  echo "       Check the Region (--region) or the stack name before retrying." >&2
  exit 1
fi

# Look up the reports bucket name from the stack output. Used only when the
# caller opts in to bucket deletion.
# shellcheck disable=SC2016  # backticks are JMESPath literal syntax, not shell expansion
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text 2>/dev/null || echo "")

echo "==> This will destroy:"
echo "    - CloudFormation stack: ${STACK_NAME} (includes the Athena database and table)"
if [ -n "$BUCKET" ]; then
  if [ "$DELETE_BUCKET_OPT" = true ]; then
    echo "    - S3 bucket: ${BUCKET} and ALL report data (--delete-bucket was passed)"
  else
    echo "    - S3 bucket ${BUCKET} is RETAINED. Re-run with --delete-bucket to remove it."
  fi
fi
echo ""

# Confirm the stack teardown. --yes skips this prompt but never implies bucket
# deletion (that has its own typed confirmation below).
if [ "$AUTO_APPROVE" != true ]; then
  read -rp "Continue with stack teardown? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# 1. Pre-destroy: remove the Athena workgroup. Its query history blocks the
#    CloudFormation delete.
echo ""
echo "==> Clearing the Athena workgroup query history..."
if aws athena delete-work-group --work-group nel-analytics --recursive-delete-option --region "$REGION" 2>/dev/null; then
  echo "  Workgroup deleted."
else
  echo "  Workgroup not found or already deleted. Skipping."
fi

# 2. Destroy the CloudFormation stack.
echo ""
echo "==> Destroying the CloudFormation stack..."
if [ "$AUTO_APPROVE" = true ]; then
  npx cdk destroy "$STACK_NAME" --force
else
  npx cdk destroy "$STACK_NAME"
fi

# 3. Defensively remove Glue catalog objects if they remain. CloudFormation
#    normally deletes the stack-managed database and table during step 2.
echo ""
echo "==> Removing the Athena/Glue catalog objects..."
if aws glue delete-table --database-name nel_analytics --name nel_reports --region "$REGION" 2>/dev/null; then
  echo "  Deleted table nel_analytics.nel_reports"
else
  echo "  Table not found. Skipping."
fi
if aws glue delete-database --name nel_analytics --region "$REGION" 2>/dev/null; then
  echo "  Deleted database nel_analytics"
else
  echo "  Database not found. Skipping."
fi

# 4. Optionally delete the retained S3 bucket. This is gated behind the explicit
#    --delete-bucket flag AND a typed confirmation, so --yes on its own never
#    causes permanent data loss.
if [ -n "$BUCKET" ] && [ "$DELETE_BUCKET_OPT" = true ]; then
  echo ""
  echo "  WARNING: this permanently deletes bucket ${BUCKET} and ALL report data. This cannot be undone."
  read -rp "  Type the bucket name to confirm deletion: " typed
  if [ "$typed" = "$BUCKET" ]; then
    echo "==> Emptying and deleting the bucket..."
    aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION"
    aws s3 rb "s3://${BUCKET}" --region "$REGION"
    echo "  Bucket deleted."
  else
    echo "  Input did not match the bucket name. Bucket retained."
  fi
elif [ -n "$BUCKET" ]; then
  echo ""
  echo "  Bucket retained: ${BUCKET}"
  echo "  To delete it later: aws s3 rb s3://${BUCKET} --force --region ${REGION}"
fi

# 5. Remove the Lambda log groups created by this stack. The prefix is scoped to
#    the stack name so unrelated log groups are never matched, and delete
#    failures are reported rather than silently ignored.
echo ""
echo "==> Removing the stack's Lambda log groups..."
LOG_PREFIX="/aws/lambda/${STACK_NAME}"
LOG_GROUPS=$(aws logs describe-log-groups --log-group-name-prefix "$LOG_PREFIX" \
  --region "$REGION" --query 'logGroups[*].logGroupName' --output text 2>/dev/null || true)
if [ -z "$LOG_GROUPS" ]; then
  echo "  No log groups found under ${LOG_PREFIX}. Skipping."
else
  for lg in $LOG_GROUPS; do
    if aws logs delete-log-group --log-group-name "$lg" --region "$REGION" 2>/dev/null; then
      echo "  Deleted $lg"
    else
      echo "  WARNING: failed to delete $lg. Delete it manually if needed."
    fi
  done
fi

echo ""
echo "Cleanup complete."
