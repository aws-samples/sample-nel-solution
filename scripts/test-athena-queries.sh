#!/usr/bin/env bash
# Test all Athena queries from docs/athena-queries.md
# Usage: ./scripts/test-athena-queries.sh [--region REGION]
set -euo pipefail

DB="nel_analytics"
WORKGROUP="nel-analytics"
REGION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --region)
      if [ $# -ge 2 ]; then REGION="$2"; shift; else echo "ERROR: --region needs a value" >&2; exit 2; fi
      ;;
    --region=*) REGION="${1#*=}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$REGION" ]; then
  REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
fi
if [ -z "$REGION" ]; then
  echo "ERROR: no AWS Region resolved. Pass --region REGION or configure the AWS CLI." >&2
  exit 1
fi

YEAR=$(date -u +%Y)
MONTH=$(date -u +%m)
DAY=$(date -u +%d)

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0

run_query() {
  local name="$1" sql="$2"
  local qid state reason
  TOTAL=$((TOTAL + 1))
  # Start query
  qid=$(aws athena start-query-execution \
    --query-string "$sql" \
    --query-execution-context "Database=${DB}" \
    --work-group "${WORKGROUP}" \
    --region "${REGION}" \
    --output text --query 'QueryExecutionId' 2>&1) || { echo -e "  ${RED}FAIL${NC}  ${name} (submit error)"; FAIL=$((FAIL+1)); return; }

  # Poll for completion (max 30s)
  for _ in {1..30}; do
    state=$(aws athena get-query-execution --query-execution-id "$qid" \
      --region "${REGION}" \
      --output text --query 'QueryExecution.Status.State' 2>/dev/null)
    case "$state" in
      SUCCEEDED) echo -e "  ${GREEN}OK${NC}    ${name}"; PASS=$((PASS+1)); return ;;
      FAILED|CANCELLED)
        reason=$(aws athena get-query-execution --query-execution-id "$qid" \
          --region "${REGION}" \
          --output text --query 'QueryExecution.Status.StateChangeReason' 2>/dev/null)
        echo -e "  ${RED}FAIL${NC}  ${name}: ${reason}"; FAIL=$((FAIL+1)); return ;;
    esac
    sleep 1
  done
  aws athena stop-query-execution --query-execution-id "$qid" --region "${REGION}" >/dev/null 2>&1 || true
  echo -e "  ${RED}FAIL${NC}  ${name} (timeout; query cancelled)"; FAIL=$((FAIL+1))
}

echo -e "\n${BLUE}NEL Athena Query Tester${NC}"
echo -e "Workgroup: ${WORKGROUP}"
echo -e "Region:    ${REGION}"
echo -e "Date:      ${YEAR}-${MONTH}-${DAY}\n"

# -- Top Errors --
run_query "Top error types" \
  "SELECT body.type, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY body.type ORDER BY cnt DESC LIMIT 20"

run_query "Errors by phase" \
  "SELECT CASE WHEN body.type LIKE 'dns.%' THEN 'dns' WHEN body.type LIKE 'tcp.%' OR body.type LIKE 'tls.%' THEN 'connection' WHEN body.type LIKE 'http.%' THEN 'application' ELSE 'other' END AS phase, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY 1 ORDER BY cnt DESC"

# -- Failing URLs --
run_query "Top failing URLs" \
  "SELECT url, COUNT(*) as errors, ARRAY_AGG(DISTINCT body.type) as error_types FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY url ORDER BY errors DESC LIMIT 20"

run_query "URLs with multiple error types" \
  "SELECT url, COUNT(*) as errors, COUNT(DISTINCT body.type) as distinct_errors FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY url HAVING COUNT(DISTINCT body.type) > 1 ORDER BY distinct_errors DESC LIMIT 20"

# -- DNS --
run_query "DNS failures by domain" \
  "SELECT url_extract_host(url) as domain, body.type, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type LIKE 'dns.%' GROUP BY url_extract_host(url), body.type ORDER BY cnt DESC LIMIT 20"

# -- TLS --
run_query "TLS errors by server" \
  "SELECT body.server_ip, body.protocol, body.type, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type LIKE 'tls.%' GROUP BY body.server_ip, body.protocol, body.type ORDER BY cnt DESC LIMIT 20"

run_query "Certificate errors" \
  "SELECT url, body.type, body.server_ip, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type LIKE 'tls.cert.%' GROUP BY url, body.type, body.server_ip ORDER BY cnt DESC LIMIT 20"

# -- HTTP --
run_query "HTTP errors by status code" \
  "SELECT body.status_code, body.method, url, body.type, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type LIKE 'http.%' AND body.status_code > 0 GROUP BY body.status_code, body.method, url, body.type ORDER BY cnt DESC LIMIT 20"

# -- Latency --
run_query "Slowest failures" \
  "SELECT url, body.type, body.elapsed_time, body.server_ip, body.method FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.elapsed_time > 5000 ORDER BY body.elapsed_time DESC LIMIT 50"

run_query "Avg elapsed by error type" \
  "SELECT body.type, COUNT(*) as cnt, AVG(body.elapsed_time) as avg_ms, MAX(body.elapsed_time) as max_ms, APPROX_PERCENTILE(body.elapsed_time, 0.95) as p95_ms FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY body.type ORDER BY avg_ms DESC"

# -- Trends --
run_query "Daily error rate" \
  "SELECT day, COUNT(*) as total, SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) as errors, ROUND(100.0 * SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) / COUNT(*), 2) as error_pct FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' GROUP BY day ORDER BY day"

# -- Server / Infra --
run_query "Top failing server IPs" \
  "SELECT body.server_ip, COUNT(*) as errors, ARRAY_AGG(DISTINCT body.type) as types FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' AND body.server_ip IS NOT NULL AND body.server_ip != '' GROUP BY body.server_ip ORDER BY errors DESC LIMIT 20"

run_query "Errors by HTTP method" \
  "SELECT body.method, body.type, COUNT(*) as cnt FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok' GROUP BY body.method, body.type ORDER BY cnt DESC"

# -- Success Rate --
run_query "Overall success rate" \
  "SELECT COUNT(*) as total, SUM(CASE WHEN body.type = 'ok' THEN 1 ELSE 0 END) as success, SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) as errors, ROUND(100.0 * SUM(CASE WHEN body.type = 'ok' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_pct FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'"

run_query "Success rate by domain" \
  "SELECT url_extract_host(url) as domain, COUNT(*) as total, ROUND(100.0 * SUM(CASE WHEN body.type = 'ok' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_pct FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' GROUP BY url_extract_host(url) ORDER BY total DESC LIMIT 20"

# -- Data Exploration --
run_query "Sample raw records" \
  "SELECT * FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' LIMIT 10"

run_query "Distinct error types" \
  "SELECT DISTINCT body.type FROM ${DB}.nel_reports WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' ORDER BY body.type"

# -- Summary --
echo -e "\n${BLUE}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total"
[ "$FAIL" -eq 0 ] && echo -e "${GREEN}All queries valid${NC}" || echo -e "${RED}Some queries failed${NC}"
exit "$FAIL"
