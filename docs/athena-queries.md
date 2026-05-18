# NEL Athena Query Cookbook

This cookbook provides Amazon Athena query patterns for analyzing NEL (Network Error Logging) reports stored in the `nel_analytics.nel_reports` table. Queries are organized by use case: time filtering, overview statistics, error breakdown by phase (DNS, TCP, TLS, HTTP), and operational analysis. Each query uses partition projection for efficient scanning.

All queries target `nel_analytics.nel_reports` (Parquet format, partition projection). Always include partition filters (`year`, `month`, `day`) to minimize scan cost ($5/TB scanned).

Replace `${YEAR}`, `${MONTH}`, `${DAY}` with your target date values.

## Time Filters

```sql
-- Single day
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'

-- Date range (same month)
WHERE year='${YEAR}' AND month='${MONTH}' AND day BETWEEN '${START_DAY}' AND '${END_DAY}'

-- Cross-month range
WHERE (year='2026' AND month='03' AND day >= '25')
   OR (year='2026' AND month='04' AND day <= '08')
```

## Overview

```sql
-- Overall stats: total, success, errors, error rate
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN body.type = 'ok' THEN 1 ELSE 0 END) as success,
  SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) as errors,
  ROUND(100.0 * SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) / COUNT(*), 1) as error_pct
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}';
```

## Top Error Types

```sql
-- Top 20 error types
SELECT body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY body.type
ORDER BY cnt DESC LIMIT 20;

-- Errors by phase (dns / connection / application)
SELECT body.phase, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY body.phase
ORDER BY cnt DESC;
```

## Top Failing URLs

```sql
-- Top 20 failing URLs with error breakdown
SELECT url, COUNT(*) as errors, ARRAY_AGG(DISTINCT body.type) as types
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY url
ORDER BY errors DESC LIMIT 20;

-- URLs with multiple distinct error types (systemic issues)
SELECT url, COUNT(*) as errors, COUNT(DISTINCT body.type) as distinct_types,
       ARRAY_AGG(DISTINCT body.type) as types
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY url
HAVING COUNT(DISTINCT body.type) > 1
ORDER BY distinct_types DESC LIMIT 20;
```

## Top Failing Server IPs

```sql
-- Top failing IPs with error type breakdown
SELECT body.server_ip, COUNT(*) as errors, ARRAY_AGG(DISTINCT body.type) as types
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
  AND body.server_ip IS NOT NULL AND body.server_ip != ''
GROUP BY body.server_ip
ORDER BY errors DESC LIMIT 20;

-- Errors by IP and protocol
SELECT body.server_ip, body.protocol, COUNT(*) as errors,
       ARRAY_AGG(DISTINCT body.type) as types
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
  AND body.server_ip IS NOT NULL AND body.server_ip != ''
GROUP BY body.server_ip, body.protocol
ORDER BY errors DESC LIMIT 20;
```

## DNS Issues

```sql
-- DNS failures by domain
SELECT url_extract_host(url) as domain, body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type LIKE 'dns.%'
GROUP BY url_extract_host(url), body.type
ORDER BY cnt DESC LIMIT 20;
```

## TLS / Certificate Issues

```sql
-- TLS errors by server IP and protocol
SELECT body.server_ip, body.protocol, body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type LIKE 'tls.%'
GROUP BY body.server_ip, body.protocol, body.type
ORDER BY cnt DESC LIMIT 20;

-- Certificate errors specifically
SELECT url, body.type, body.server_ip, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type LIKE 'tls.cert.%'
GROUP BY url, body.type, body.server_ip
ORDER BY cnt DESC LIMIT 20;
```

## HTTP / Application Errors

```sql
-- HTTP errors by status code
SELECT body.status_code, body.method, body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type LIKE 'http.%'
  AND body.status_code > 0
GROUP BY body.status_code, body.method, body.type
ORDER BY cnt DESC LIMIT 20;

-- HTTP errors by URL
SELECT body.status_code, body.method, url, body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type LIKE 'http.%'
  AND body.status_code > 0
GROUP BY body.status_code, body.method, url, body.type
ORDER BY cnt DESC LIMIT 20;
```

## Latency / Slow Failures

```sql
-- Slowest failures (> 5 seconds)
SELECT url, body.type, body.elapsed_time, body.server_ip, body.method,
       metadata.received_at
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.elapsed_time > 5000
ORDER BY body.elapsed_time DESC LIMIT 50;

-- Average and p95 elapsed time by error type
SELECT body.type, COUNT(*) as cnt,
       ROUND(AVG(body.elapsed_time)) as avg_ms,
       MAX(body.elapsed_time) as max_ms,
       APPROX_PERCENTILE(body.elapsed_time, 0.95) as p95_ms
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY body.type
ORDER BY avg_ms DESC;
```

## Success Rate

```sql
-- Success rate by domain
SELECT url_extract_host(url) as domain, COUNT(*) as total,
       SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) as errors,
       ROUND(100.0 * SUM(CASE WHEN body.type = 'ok' THEN 1 ELSE 0 END) / COUNT(*), 1) as success_pct
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
GROUP BY url_extract_host(url)
ORDER BY total DESC LIMIT 20;

-- Errors by HTTP method
SELECT body.method, body.type, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
  AND body.type != 'ok'
GROUP BY body.method, body.type
ORDER BY cnt DESC LIMIT 20;
```

## Trends Over Time

```sql
-- Daily error volume
SELECT year, month, day, COUNT(*) as total,
       SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) as errors,
       ROUND(100.0 * SUM(CASE WHEN body.type != 'ok' THEN 1 ELSE 0 END) / COUNT(*), 1) as error_pct
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day BETWEEN '${START_DAY}' AND '${END_DAY}'
GROUP BY year, month, day
ORDER BY year, month, day;

-- New error types appearing (compare two days)
SELECT body.type FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}' AND body.type != 'ok'
GROUP BY body.type
EXCEPT
SELECT body.type FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${PREV_DAY}' AND body.type != 'ok'
GROUP BY body.type;

-- Report volume by day
SELECT day, COUNT(*) as cnt
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}'
GROUP BY day ORDER BY day;
```

## Data Exploration

```sql
-- Sample raw records
SELECT * FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
LIMIT 10;

-- Distinct error types seen
SELECT DISTINCT body.type
FROM nel_analytics.nel_reports
WHERE year='${YEAR}' AND month='${MONTH}' AND day='${DAY}'
ORDER BY body.type;
```

## Conclusion

These query patterns cover the most common NEL analysis scenarios. Always include partition filters (`year`, `month`, `day`) to control scan costs. For real-time monitoring, use the CloudWatch dashboard and Contributor Insights rules described in [Monitoring](monitoring.md). For field definitions and the full NEL report schema, see [API Schema](api-schema.md).
