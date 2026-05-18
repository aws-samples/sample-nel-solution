# NEL Protocol Reference

Reference for the W3C NEL and Reporting API protocols. Covers the Amazon API Gateway configuration and AWS WAF rules.

Sources: [W3C NEL](https://www.w3.org/TR/network-error-logging/), [W3C Reporting API](https://www.w3.org/TR/reporting-1/)

---

## 1. Protocol Overview

NEL is a two-part system:

1. **Policy delivery**: Server sends `NEL` + `Report-To` response headers to opt-in
2. **Report delivery**: Browser POSTs error reports to the configured endpoint

The reporting endpoint (this pipeline) only handles part 2 -- receiving reports.

---

## 2. Report Delivery (Inbound to Endpoint)

### HTTP Request

| Property | Value |
|----------|-------|
| Method | `POST` |
| Content-Type | `application/reports+json` |
| Credentials | `same-origin` (cookies only for same-origin endpoints) |
| Mode | `cors` |
| Body | JSON array of report objects |

### Request Headers

| Header | Spec | Description |
|--------|------|-------------|
| `Content-Type` | Required | `application/reports+json` (W3C Reporting API section 2.2, 3.5.2) |
| `Origin` | Standard | Origin of the page that generated the report (CORS) |
| `User-Agent` | Standard | Browser user agent string |

The W3C spec mandates `application/reports+json`.

No custom headers. No auth tokens. Browsers send NEL reports autonomously -- there is no mechanism to attach authorization headers.

### Expected Response

| Status | Meaning |
|--------|---------|
| 2xx | Report accepted |
| 410 Gone | Endpoint removed -- browser stops sending to this endpoint |
| Other | Delivery failure -- browser may retry |

The response body is ignored by the browser.

---

## 3. Report Envelope (Reporting API)

Each POST body is a JSON array of report objects. Each report has this envelope:

```json
{
  "age": 0,
  "type": "network-error",
  "url": "https://example.com/page",
  "user_agent": "Mozilla/5.0 ...",
  "body": { ... }
}
```

| Field | Type | Spec | Description |
|-------|------|------|-------------|
| `age` | integer | Always | Milliseconds between report generation and upload |
| `type` | string | Always | Always `"network-error"` for NEL |
| `url` | string | Always | URL of the request that triggered the report (credentials/fragment stripped) |
| `user_agent` | string | Always | User-Agent of the page that generated the report |
| `body` | object | Always | NEL-specific report body (see below) |

Per Reporting API section 2.4 ("Serialize Reports"), all five fields are always present in the serialized output.

---

## 4. NEL Report Body

The `body` object contains the network error details. Fields vary by error phase.

### Always present (NEL spec section 5.2, step 6)

| Field | Type | Description |
|-------|------|-------------|
| `sampling_fraction` | number | 0.0-1.0, the sampling rate that selected this report |
| `elapsed_time` | integer | Milliseconds from request start to completion/abort |
| `phase` | string | `"dns"`, `"connection"`, or `"application"` |
| `type` | string | Error type (see section 6) or `"ok"` for success |

### Present when phase != "dns" (step 7)

| Field | Type | Description |
|-------|------|-------------|
| `server_ip` | string | IP address of the server (IPv4 dotted or IPv6), or `""` |
| `protocol` | string | ALPN protocol ID (`"h2"`, `"http/1.1"`, `"h3"`), or `""` |

### Present when phase == "application" (step 8)

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method (`"GET"`, `"POST"`, etc.) |
| `status_code` | integer | HTTP status code, or `0` if unavailable |
| `referrer` | string | Referrer URL per referrer policy |

### Full body example (application phase)

```json
{
  "sampling_fraction": 1.0,
  "referrer": "https://example.com/",
  "server_ip": "192.0.2.42",
  "protocol": "h2",
  "method": "GET",
  "status_code": 200,
  "elapsed_time": 823,
  "phase": "application",
  "type": "http.protocol.error"
}
```

### Minimal body example (DNS phase)

```json
{
  "sampling_fraction": 1.0,
  "server_ip": "",
  "protocol": "",
  "elapsed_time": 143,
  "phase": "dns",
  "type": "dns.name_not_resolved"
}
```

---

## 5. Complete Report Examples

### Single report (browser format)

```json
[{
  "age": 0,
  "type": "network-error",
  "url": "https://www.example.com/",
  "user_agent": "Mozilla/5.0 (X11; Linux x86_64; rv:60.0) Gecko/20100101 Firefox/60.0",
  "body": {
    "sampling_fraction": 0.5,
    "referrer": "http://example.com/",
    "server_ip": "2001:DB8:0:0:0:0:0:42",
    "protocol": "h2",
    "method": "GET",
    "status_code": 200,
    "elapsed_time": 823,
    "phase": "application",
    "type": "http.protocol.error"
  }
}]
```

### Single report (curl/testing convenience)

Our endpoint also accepts a single object (not wrapped in array):

```json
{
  "type": "network-error",
  "url": "https://example.com",
  "body": {
    "type": "dns.name_not_resolved",
    "phase": "dns",
    "elapsed_time": 5000,
    "sampling_fraction": 1.0
  }
}
```

---

## 6. Predefined Error Types

### DNS resolution (phase: `dns`)

| Type | Description |
|------|-------------|
| `dns.unreachable` | DNS server is unreachable |
| `dns.name_not_resolved` | DNS server cannot resolve the address |
| `dns.failed` | DNS request failed (other reasons) |
| `dns.address_changed` | Resolved IP changed since NEL policy was received |

### Secure connection (phase: `connection`)

| Type | Description |
|------|-------------|
| `tcp.timed_out` | TCP connection timed out |
| `tcp.closed` | TCP connection closed by server |
| `tcp.reset` | TCP connection reset |
| `tcp.refused` | TCP connection refused |
| `tcp.aborted` | TCP connection stopped |
| `tcp.address_invalid` | IP address is invalid |
| `tcp.address_unreachable` | IP address is unreachable |
| `tcp.failed` | TCP connection failed (other reasons) |
| `tls.version_or_cipher_mismatch` | TLS version or cipher mismatch |
| `tls.bad_client_auth_cert` | Bad client auth certificate |
| `tls.cert.name_invalid` | Certificate name invalid |
| `tls.cert.date_invalid` | Certificate date invalid |
| `tls.cert.authority_invalid` | Certificate authority invalid |
| `tls.cert.invalid` | Certificate invalid |
| `tls.cert.revoked` | Certificate revoked |
| `tls.cert.pinned_key_not_in_cert_chain` | Pinned key not in cert chain |
| `tls.protocol.error` | TLS protocol error |
| `tls.failed` | TLS connection failed (other reasons) |

### Application (phase: `application`)

| Type | Description |
|------|-------------|
| `http.error` | 4xx or 5xx response received |
| `http.protocol.error` | HTTP protocol error |
| `http.response.invalid` | Invalid response (content-length mismatch, encoding, etc.) |
| `http.response.redirect_loop` | Redirect loop detected |
| `http.failed` | HTTP connection failed (other reasons) |

### Other

| Type | Description |
|------|-------------|
| `abandoned` | User aborted the request |
| `unknown` | Unknown error |
| `ok` | Successful request (sampled via `success_fraction`) |

---

## 7. Policy Headers (Server-Side Configuration)

These headers are set on the origin server (not the reporting endpoint) to enable NEL:

### `Report-To` header

```
Report-To: {
  "group": "nel",
  "max_age": 86400,
  "endpoints": [{"url": "https://nel-endpoint.example.com/prod/"}]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `group` | string | Yes | Endpoint group name (referenced by NEL header) |
| `max_age` | integer | Yes | Seconds the endpoint config is valid |
| `endpoints` | array | Yes | Array of `{"url": "..."}` objects |

### `NEL` header

```
NEL: {
  "report_to": "nel",
  "max_age": 86400,
  "include_subdomains": true,
  "success_fraction": 0.01,
  "failure_fraction": 1.0
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `report_to` | string | Yes* | -- | Endpoint group name from `Report-To` |
| `max_age` | integer | Yes | -- | Seconds the NEL policy is valid. `0` removes policy |
| `include_subdomains` | boolean | No | `false` | Apply to all subdomains |
| `success_fraction` | number | No | `0.0` | Sampling rate for successful requests (0.0-1.0) |
| `failure_fraction` | number | No | `1.0` | Sampling rate for failed requests (0.0-1.0) |

*Required to register. Optional when removing (`max_age: 0`).

---

## 8. Amazon API Gateway Implementation Notes

### Path

Single path: `POST /prod/`

### Supported Content Type

- `application/reports+json` (W3C standard, mandatory per Reporting API section 2.2)
- All other content types rejected with 415 (`passthroughBehavior: NEVER`)

### Request validation

API Gateway model validates:
- Single object: requires `type` (string), `url` (string), and `body` (object with `body.type`, `body.phase`, `body.elapsed_time`, `body.sampling_fraction`)
- Array of objects: each element requires `type`, `url`, and `body` (same body requirements)

### AWS WAF validation (positive security model)

| Rule | Priority | Check | Label |
|------|----------|-------|-------|
| RateLimitPerIP | 10 | 2000 req/min/IP | -- (block) |
| AWSIPReputation | 20 | Known bad IPs | -- (block) |
| AWSKnownBadInputs | 30 | Log4j, traversal | -- (block) |
| AWSCoreRuleSet | 40 | OWASP top 10 | -- (block) |
| ValidatePath | 100 | URI == `/prod/` | `nel:valid-path` |
| ValidateMethod | 110 | POST or OPTIONS | `nel:valid-method` |
| ValidateBody | 120 | Body contains `"type":`, `"url":`, `"body":`, `"phase":`, `"elapsed_time":`, `"sampling_fraction":` | `nel:valid-body` |
| AllowCORSPreflight | 9998 | valid-path + valid-method + OPTIONS | allow |
| AllowValidRequests | 9999 | All 3 labels present | allow |
| Default | -- | Everything else | block |

### CORS

OPTIONS preflight handled by API Gateway `defaultCorsPreflightOptions`:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`
- `Access-Control-Max-Age: 86400`

### Response codes

| Code | When |
|------|------|
| 200 | Report accepted |
| 400 | Request body validation failed |
| 403 | WAF blocked |
| 415 | Unsupported Content Type (only `application/reports+json` accepted) |
| 500 | Internal error |

## Conclusion

This document covers the full API surface: the W3C NEL report schema, AWS WAF positive security model rules, and Amazon API Gateway integration configuration. Use the [test scripts](../scripts/README.md) to validate all 30 NEL error types against your deployed endpoint, and see [NEL Headers](nel-headers.md) for end-to-end setup.
