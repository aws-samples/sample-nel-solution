#!/usr/bin/env bash

################################################################################
# NEL Data Generator
# 
# This script generates random Network Error Logging (NEL) reports and sends
# them to the API Gateway endpoint for testing purposes.
#
# Usage:
#   ./scripts/generate-nel-data.sh <API_ENDPOINT> [INTERVAL_SECONDS] [BATCH_SIZE]
#
# Arguments:
#   API_ENDPOINT      - The API Gateway endpoint URL (required)
#   INTERVAL_SECONDS  - Seconds between batches (default: 5)
#   BATCH_SIZE        - Number of reports per batch (default: 10)
#
# Example:
#   ./scripts/generate-nel-data.sh https://abc123.execute-api.us-east-1.amazonaws.com/prod/ 3 20
################################################################################

set -euo pipefail

# Configuration
API_ENDPOINT="${1:-}"
INTERVAL_SECONDS="${2:-5}"
BATCH_SIZE="${3:-10}"

# Validate API endpoint
if [[ -z "$API_ENDPOINT" ]]; then
    echo "Error: API endpoint is required"
    echo "Usage: $0 <API_ENDPOINT> [INTERVAL_SECONDS] [BATCH_SIZE]"
    echo "Example: $0 https://abc123.execute-api.us-east-1.amazonaws.com/prod/ 5 10"
    exit 1
fi
if [[ ! "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: INTERVAL_SECONDS must be a positive integer" >&2
    exit 1
fi
if [[ ! "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: BATCH_SIZE must be a positive integer" >&2
    exit 1
fi

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Arrays for random data generation
ERROR_TYPES=(
    "dns.name_not_resolved"
    "dns.unreachable"
    "dns.failed"
    "tcp.timed_out"
    "tcp.refused"
    "tcp.reset"
    "tcp.aborted"
    "http.error"
    "http.protocol.error"
    "http.response.invalid"
    "abandoned"
)

HTTP_METHODS=(
    "GET"
    "POST"
    "PUT"
    "DELETE"
    "PATCH"
    "HEAD"
)

DOMAINS=(
    "api.example.com"
    "cdn.example.com"
    "static.example.com"
    "images.example.com"
    "assets.example.com"
    "www.example.com"
    "app.example.com"
    "auth.example.com"
    "data.example.com"
    "services.example.com"
)

PATHS=(
    "/api/v1/users"
    "/api/v1/products"
    "/api/v1/orders"
    "/api/v2/search"
    "/assets/js/app.js"
    "/assets/css/style.css"
    "/images/logo.png"
    "/data/analytics"
    "/auth/login"
    "/services/payment"
)

PHASES=(
    "dns"
    "connection"
    "application"
)

STATUS_CODES=(
    0      # Network error (no response)
    200    # Success (for http.error type)
    400    # Bad Request
    401    # Unauthorized
    403    # Forbidden
    404    # Not Found
    500    # Internal Server Error
    502    # Bad Gateway
    503    # Service Unavailable
    504    # Gateway Timeout
)

# Function to generate random element from array
random_element() {
    local arr=("$@")
    local rand_index=$((RANDOM % ${#arr[@]}))
    echo "${arr[$rand_index]}"
}

# Function to generate random number in range
random_range() {
    local min=$1
    local max=$2
    echo $((RANDOM % (max - min + 1) + min))
}

# Function to generate a random NEL report
generate_nel_report() {
    local error_type method domain path phase age
    error_type=$(random_element "${ERROR_TYPES[@]}")
    method=$(random_element "${HTTP_METHODS[@]}")
    domain=$(random_element "${DOMAINS[@]}")
    path=$(random_element "${PATHS[@]}")
    phase=$(random_element "${PHASES[@]}")
    age=$(random_range 1 60)
    
    # Determine status code based on error type
    local status_code
    if [[ "$error_type" == dns.* ]] || [[ "$error_type" == tcp.* ]] || [[ "$error_type" == "abandoned" ]]; then
        status_code=0
    else
        status_code=$(random_element "${STATUS_CODES[@]}")
    fi
    
    # Generate elapsed time based on error type
    local elapsed_time
    case "$error_type" in
        dns.*)
            elapsed_time=$(random_range 1000 10000)
            ;;
        tcp.timed_out)
            elapsed_time=$(random_range 20000 60000)
            ;;
        tcp.*)
            elapsed_time=$(random_range 100 5000)
            ;;
        http.*)
            elapsed_time=$(random_range 500 15000)
            ;;
        abandoned)
            elapsed_time=$(random_range 5000 30000)
            ;;
        *)
            elapsed_time=$(random_range 1000 10000)
            ;;
    esac
    
    # Build JSON payload
    local json_payload
    json_payload=$(cat <<EOF
{
  "age": $age,
  "type": "network-error",
  "url": "https://${domain}${path}",
  "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "body": {
    "method": "$method",
    "status_code": $status_code,
    "elapsed_time": $elapsed_time,
    "phase": "$phase",
    "type": "$error_type",
    "sampling_fraction": 1.0
  }
}
EOF
)
    
    echo "$json_payload"
}

# Function to send NEL report to API
send_nel_report() {
    local payload="$1"
    local response
    local http_code
    
    response=$(curl -s -w "\n%{http_code}" -X POST "$API_ENDPOINT" \
        -H "Content-Type: application/reports+json" \
        -d "$payload" 2>&1)
    
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" = "200" ]; then
        return 0
    else
        echo "$response" >&2
        return 1
    fi
}

# Function to display statistics
display_stats() {
    local total=$1
    local success=$2
    local failed=$3
    local elapsed=$4
    local success_rate="0.00"
    local reports_per_second="0.00"

    if (( total > 0 )); then
        success_rate=$(awk -v success="$success" -v total="$total" 'BEGIN {printf "%.2f", (success/total)*100}')
    fi
    if (( elapsed > 0 )); then
        reports_per_second=$(awk -v total="$total" -v elapsed="$elapsed" 'BEGIN {printf "%.2f", total/elapsed}')
    fi

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}                    Statistics Summary${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "Total Reports Sent:     ${YELLOW}$total${NC}"
    echo -e "Successful:             ${GREEN}$success${NC}"
    echo -e "Failed:                 ${RED}$failed${NC}"
    echo -e "Success Rate:           ${YELLOW}${success_rate}%${NC}"
    echo -e "Running Time:           ${YELLOW}${elapsed}s${NC}"
    echo -e "Reports per Second:     ${YELLOW}${reports_per_second}${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"
}

# Initialize counters before installing the signal handler.
total_sent=0
successful_sends=0
failed_sends=0
batch_number=0
start_time=$SECONDS

# Trap Ctrl+C to display final statistics.
trap 'echo -e "\n${YELLOW}Stopping data generation...${NC}"; display_stats "$total_sent" "$successful_sends" "$failed_sends" "$((SECONDS - start_time))"; exit 0' INT TERM

# Main execution
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          NEL Data Generator - Starting...                 ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo -e "\n${BLUE}Configuration:${NC}"
echo -e "  API Endpoint:    ${YELLOW}$API_ENDPOINT${NC}"
echo -e "  Interval:        ${YELLOW}${INTERVAL_SECONDS}s${NC}"
echo -e "  Batch Size:      ${YELLOW}${BATCH_SIZE} reports${NC}"
echo -e "\n${YELLOW}Press Ctrl+C to stop and view statistics${NC}\n"

# Main loop
while true; do
    batch_number=$((batch_number + 1))
    batch_success=0
    batch_failed=0
    
    echo -e "${BLUE}[Batch #$batch_number]${NC} Generating and sending $BATCH_SIZE reports..."
    
    for i in $(seq 1 "$BATCH_SIZE"); do
        # Generate random NEL report
        nel_report=$(generate_nel_report)
        
        # Extract error type for display
        error_type=$(echo "$nel_report" | grep -o '"type": "[^"]*"' | tail -1 | cut -d'"' -f4)
        
        # Send to API
        if send_nel_report "$nel_report"; then
            echo -e "  ${GREEN}✓${NC} Report $i sent successfully (${error_type})"
            successful_sends=$((successful_sends + 1))
            batch_success=$((batch_success + 1))
        else
            echo -e "  ${RED}✗${NC} Report $i failed (${error_type})"
            failed_sends=$((failed_sends + 1))
            batch_failed=$((batch_failed + 1))
        fi
        
        total_sent=$((total_sent + 1))
    done
    
    # Display batch summary
    echo -e "${BLUE}[Batch #$batch_number]${NC} Complete: ${GREEN}$batch_success${NC} success, ${RED}$batch_failed${NC} failed"
    
    # Display running statistics every 5 batches
    if [ $((batch_number % 5)) -eq 0 ]; then
        elapsed=$((SECONDS - start_time))
        display_stats $total_sent $successful_sends $failed_sends $elapsed
    fi
    
    # Wait before next batch
    echo -e "${YELLOW}Waiting ${INTERVAL_SECONDS}s before next batch...${NC}\n"
    sleep "$INTERVAL_SECONDS"
done
