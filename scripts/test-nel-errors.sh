#!/bin/bash
################################################################################
# NEL Error Type Test Script
#
# Sends W3C NEL reports for every predefined error type (29 types + ok).
# Can also send a random batch of up to 100 reports.
#
# Usage:
#   ./scripts/test-nel-errors.sh <API_ENDPOINT> [OPTIONS]
#
# Options:
#   --all           Send one report per error type (default)
#   --random N      Send N random reports (1-100)
#   --type TYPE     Send a single specific error type
#   --list          List all error types and exit
#   --verbose       Show full curl response
#
# Examples:
#   ./scripts/test-nel-errors.sh https://abc.execute-api.us-east-1.amazonaws.com/prod/
#   ./scripts/test-nel-errors.sh https://abc.execute-api.us-east-1.amazonaws.com/prod/ --random 50
#   ./scripts/test-nel-errors.sh https://abc.execute-api.us-east-1.amazonaws.com/prod/ --type dns.failed
################################################################################

set -euo pipefail

# -- Color codes ---------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

# -- W3C NEL error types (Section 6) ------------------------------------------
# Format: "type|phase|status_code|elapsed_min|elapsed_max"
declare -a NEL_ERRORS=(
  # DNS (phase: dns)
  "dns.unreachable|dns|0|1000|8000"
  "dns.name_not_resolved|dns|0|2000|10000"
  "dns.failed|dns|0|1000|5000"
  "dns.address_changed|dns|0|500|3000"
  # TCP (phase: connection)
  "tcp.timed_out|connection|0|20000|60000"
  "tcp.closed|connection|0|100|3000"
  "tcp.reset|connection|0|50|2000"
  "tcp.refused|connection|0|50|1000"
  "tcp.aborted|connection|0|100|5000"
  "tcp.address_invalid|connection|0|10|500"
  "tcp.address_unreachable|connection|0|5000|30000"
  "tcp.failed|connection|0|1000|10000"
  # TLS (phase: connection)
  "tls.version_or_cipher_mismatch|connection|0|500|3000"
  "tls.bad_client_auth_cert|connection|0|300|2000"
  "tls.cert.name_invalid|connection|0|200|1500"
  "tls.cert.date_invalid|connection|0|200|1500"
  "tls.cert.authority_invalid|connection|0|200|1500"
  "tls.cert.invalid|connection|0|200|1500"
  "tls.cert.revoked|connection|0|300|2000"
  "tls.cert.pinned_key_not_in_cert_chain|connection|0|200|1500"
  "tls.protocol.error|connection|0|500|3000"
  "tls.failed|connection|0|500|5000"
  # HTTP / Application (phase: application)
  "http.error|application|503|500|5000"
  "http.protocol.error|application|0|200|3000"
  "http.response.invalid|application|0|300|4000"
  "http.response.redirect_loop|application|0|1000|8000"
  "http.failed|application|0|500|5000"
  "abandoned|application|0|5000|30000"
  "unknown|application|0|1000|10000"
  # Success
  "ok|application|200|50|500"
)

DOMAINS=("api.example.com" "cdn.example.com" "static.example.com" "app.example.com" "auth.example.com")
PATHS=("/api/v1/users" "/api/v2/search" "/assets/js/app.js" "/images/logo.png" "/auth/login")
METHODS=("GET" "POST" "PUT" "DELETE")
SERVER_IPS=("203.0.113.10" "198.51.100.22" "192.0.2.50" "203.0.113.99" "198.51.100.7")
PROTOCOLS=("h2" "http/1.1" "h3")

# HTTP status codes for http.error type
HTTP_ERROR_CODES=(400 401 403 404 500 502 503 504)

# -- Helpers -------------------------------------------------------------------
random_element() { local arr=("$@"); echo "${arr[$((RANDOM % ${#arr[@]}))]}" ; }
random_range()   { echo $(( RANDOM % ($2 - $1 + 1) + $1 )) ; }

build_report() {
  local entry="$1"
  IFS='|' read -r etype phase status_code elapsed_min elapsed_max <<< "$entry"

  local domain; domain=$(random_element "${DOMAINS[@]}")
  local path;   path=$(random_element "${PATHS[@]}")
  local method; method=$(random_element "${METHODS[@]}")
  local age;    age=$(random_range 1 120)
  local elapsed; elapsed=$(random_range "$elapsed_min" "$elapsed_max")

  # For http.error, pick a realistic status code
  if [[ "$etype" == "http.error" ]]; then
    status_code=$(random_element "${HTTP_ERROR_CODES[@]}")
  fi

  # Optional fields based on phase
  local server_ip_field="" protocol_field=""
  if [[ "$phase" != "dns" ]]; then
    server_ip_field="\"server_ip\": \"$(random_element "${SERVER_IPS[@]}")\","
    protocol_field="\"protocol\": \"$(random_element "${PROTOCOLS[@]}")\","
  fi

  cat <<EOF
{
  "age": $age,
  "type": "network-error",
  "url": "https://${domain}${path}",
  "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "body": {
    "method": "$method",
    "status_code": $status_code,
    "elapsed_time": $elapsed,
    "phase": "$phase",
    "type": "$etype",
    ${server_ip_field}
    ${protocol_field}
    "sampling_fraction": 1.0
  }
}
EOF
}

send_report() {
  local payload="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_ENDPOINT" \
    -H "Content-Type: application/reports+json" -d "$payload" 2>/dev/null)

  if [[ "$VERBOSE" == "true" ]]; then
    local body
    body=$(curl -s -X POST "$API_ENDPOINT" -H "Content-Type: application/reports+json" -d "$payload" 2>/dev/null)
    echo -e "    ${CYAN}Response: $http_code - $body${NC}"
  fi

  [[ "$http_code" == "200" ]]
}

list_types() {
  echo -e "${BLUE}W3C NEL Error Types (${#NEL_ERRORS[@]} total)${NC}\n"
  local group=""
  for entry in "${NEL_ERRORS[@]}"; do
    IFS='|' read -r etype phase _ _ _ <<< "$entry"
    local prefix="${etype%%.*}"
    if [[ "$prefix" != "$group" ]]; then
      group="$prefix"
      case "$group" in
        dns) echo -e "\n${YELLOW}DNS Errors (phase: dns)${NC}" ;;
        tcp) echo -e "\n${YELLOW}TCP Errors (phase: connection)${NC}" ;;
        tls) echo -e "\n${YELLOW}TLS Errors (phase: connection)${NC}" ;;
        http) echo -e "\n${YELLOW}HTTP Errors (phase: application)${NC}" ;;
        abandoned|unknown) echo -e "\n${YELLOW}Other (phase: application)${NC}" ;;
        ok) echo -e "\n${YELLOW}Success${NC}" ;;
      esac
    fi
    printf "  %-45s %s\n" "$etype" "($phase)"
  done
  echo ""
}

usage() {
  sed -n '/^# Usage:/,/^####/p' "$0" | head -n -1 | sed 's/^# //' | sed 's/^#//'
  exit 0
}

# -- Parse args ----------------------------------------------------------------
API_ENDPOINT="${1:-}"
MODE="all"
RANDOM_COUNT=0
SINGLE_TYPE=""
VERBOSE="false"

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)     MODE="all"; shift ;;
    --random)  MODE="random"; RANDOM_COUNT="${2:-10}"; shift 2 ;;
    --type)    MODE="single"; SINGLE_TYPE="$2"; shift 2 ;;
    --list)    list_types; exit 0 ;;
    --verbose) VERBOSE="true"; shift ;;
    --help|-h) usage ;;
    *)         echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$API_ENDPOINT" ]]; then
  echo -e "${RED}Error: API endpoint required${NC}"
  usage
fi

# Validate --random range
if [[ "$MODE" == "random" ]]; then
  if (( RANDOM_COUNT < 1 || RANDOM_COUNT > 100 )); then
    echo -e "${RED}Error: --random must be between 1 and 100${NC}"; exit 1
  fi
fi

# -- Execute -------------------------------------------------------------------
success=0; failed=0; total=0

run_report() {
  local entry="$1"
  IFS='|' read -r etype _ _ _ _ <<< "$entry"
  local payload; payload=$(build_report "$entry")
  total=$((total + 1))

  if send_report "$payload"; then
    echo -e "  ${GREEN}OK${NC}  $etype"
    success=$((success + 1))
  else
    echo -e "  ${RED}FAIL${NC}  $etype"
    failed=$((failed + 1))
  fi
}

echo -e "\n${BLUE}NEL Error Type Tester${NC}"
echo -e "Endpoint: ${YELLOW}$API_ENDPOINT${NC}"
echo -e "Mode:     ${YELLOW}$MODE${NC}\n"

case "$MODE" in
  all)
    echo -e "${BLUE}Sending one report per error type (${#NEL_ERRORS[@]} types)...${NC}\n"
    for entry in "${NEL_ERRORS[@]}"; do
      run_report "$entry"
    done
    ;;

  random)
    echo -e "${BLUE}Sending $RANDOM_COUNT random reports...${NC}\n"
    for _ in $(seq 1 "$RANDOM_COUNT"); do
      entry=$(random_element "${NEL_ERRORS[@]}")
      run_report "$entry"
    done
    ;;

  single)
    found=""
    for entry in "${NEL_ERRORS[@]}"; do
      IFS='|' read -r etype _ _ _ _ <<< "$entry"
      if [[ "$etype" == "$SINGLE_TYPE" ]]; then
        found="$entry"; break
      fi
    done
    if [[ -z "$found" ]]; then
      echo -e "${RED}Unknown error type: $SINGLE_TYPE${NC}"
      echo "Use --list to see available types"
      exit 1
    fi
    echo -e "${BLUE}Sending single report: $SINGLE_TYPE${NC}\n"
    run_report "$found"
    ;;
esac

# -- Summary -------------------------------------------------------------------
echo -e "\n${BLUE}Results: ${GREEN}$success passed${NC}, ${RED}$failed failed${NC}, $total total"
[[ $failed -eq 0 ]] && echo -e "${GREEN}All reports accepted${NC}" || exit 1
