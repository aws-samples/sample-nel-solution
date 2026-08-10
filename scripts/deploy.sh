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

OUTPUTS_FILE="cdk-outputs.json"

if [ "$AUTO_APPROVE" = true ]; then
  npx cdk deploy --require-approval never --outputs-file "$OUTPUTS_FILE"
else
  read -rp "Deploy? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
  npx cdk deploy --outputs-file "$OUTPUTS_FILE"
fi

# Print the deployed stack outputs. Using `cdk deploy --outputs-file` is the
# AWS-recommended way to capture outputs after a deployment: the CDK CLI writes
# them to JSON keyed by stack name, so this script never hardcodes a stack name
# or Region and works for whatever environment the app deploys into.
# Reference: https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html
echo ""
echo "==> Stack outputs (from ${OUTPUTS_FILE}):"
if [ -f "$OUTPUTS_FILE" ]; then
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [stack, outputs] of Object.entries(data)) {
      console.log("  " + stack + ":");
      for (const [key, value] of Object.entries(outputs)) {
        console.log("    " + key + " = " + value);
      }
    }
  ' "$OUTPUTS_FILE"
else
  echo "  No outputs file was produced (deployment may have been skipped)."
fi
