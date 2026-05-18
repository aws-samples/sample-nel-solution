#!/usr/bin/env bash
# Deploy the NEL Reporting Pipeline stack.
# Usage: ./scripts/deploy.sh [--yes]
set -euo pipefail

cd "$(dirname "$0")/.."

AUTO_APPROVE=false
for arg in "$@"; do
  case "$arg" in
    --yes) AUTO_APPROVE=true ;;
  esac
done

# Show monitoring toggle status
MONITORING=$(node -e "console.log(require('./cdk.json').context.enableMonitoring ?? true)")
echo "==> enableMonitoring: ${MONITORING}"
echo ""

echo "==> Installing dependencies..."
npm ci --silent

echo "==> Compiling TypeScript..."
npx tsc

echo "==> Reviewing changes..."
npx cdk diff 2>&1 || true
echo ""

if [ "$AUTO_APPROVE" = true ]; then
  npx cdk deploy --require-approval never
else
  read -rp "Deploy? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  npx cdk deploy
fi

# Print outputs
echo ""
echo "==> Stack outputs:"
aws cloudformation describe-stacks --stack-name NelProjectStack --region us-east-1 \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table 2>/dev/null || true
