# Configuring NEL Headers

NEL (Network Error Logging) headers instruct browsers to report network failures back to your collection endpoint. When a browser encounters a DNS, TCP, TLS, or HTTP error on your domain, it sends a structured report to the URL specified in these headers. This guide shows how to configure NEL headers on Amazon CloudFront or your origin server.

## Prerequisites

Before configuring NEL headers, you need:

- NEL Reporting Pipeline deployed (`cdk deploy` — see main [README](../README.md))
- The `APIEndpoint` output value from your deployment
- AWS CLI installed and configured with appropriate permissions
- An existing Amazon CloudFront distribution or web server to configure

## Configuration

Add these response headers to your web application (or CloudFront Response Headers Policy):

```
Report-To: {"group":"nel","max_age":86400,"endpoints":[{"url":"https://YOUR-API-ENDPOINT/prod/"}]}
NEL: {"report_to":"nel","max_age":86400,"include_subdomains":true,"success_fraction":0.01,"failure_fraction":1.0}
```

## Amazon CloudFront Response Headers Policy

To enable NEL on an Amazon CloudFront distribution, create a custom response headers policy with the two headers above. Replace `YOUR-API-ENDPOINT` with the `APIEndpoint` output from `cdk deploy`.

### AWS Console

1. Open CloudFront > Policies > Response headers > Create response headers policy
2. Under Custom headers, add the `Report-To` header with value `{"group":"nel","max_age":86400,"endpoints":[{"url":"https://YOUR-API-ENDPOINT/prod/"}]}`
3. Add the `NEL` header with value `{"report_to":"nel","max_age":86400,"include_subdomains":true,"success_fraction":0.01,"failure_fraction":1.0}`
4. Set Origin override to No for both (so origin headers take precedence if present)
5. Save the policy
6. Attach the policy to your distribution's behavior(s)

### AWS CLI

```bash
aws cloudfront create-response-headers-policy --response-headers-policy-config '{
  "Name": "NEL-Reporting-Policy",
  "Comment": "Enables Network Error Logging via W3C NEL spec",
  "CustomHeadersConfig": {
    "Quantity": 2,
    "Items": [
      {
        "Header": "Report-To",
        "Value": "{\"group\":\"nel\",\"max_age\":86400,\"endpoints\":[{\"url\":\"https://YOUR-API-ENDPOINT/prod/\"}]}",
        "Override": false
      },
      {
        "Header": "NEL",
        "Value": "{\"report_to\":\"nel\",\"max_age\":86400,\"include_subdomains\":true,\"success_fraction\":0.01,\"failure_fraction\":1.0}",
        "Override": false
      }
    ]
  }
}'
```

Note the `Id` from the response, then attach it to your distribution:

```bash
# Get current distribution config and ETag
aws cloudfront get-distribution-config --id YOUR-DISTRIBUTION-ID > dist-config.json

# In dist-config.json, add "ResponseHeadersPolicyId": "POLICY-ID" to the DefaultCacheBehavior section
# Then update the distribution:
aws cloudfront update-distribution \
  --id YOUR-DISTRIBUTION-ID \
  --distribution-config file://dist-config.json \
  --if-match ETAG-FROM-GET
```

## Verify Configuration

1. Use curl to check the headers:
   ```bash
   curl -I https://your-domain.example.com/
   ```
   Look for the `Report-To` and `NEL` headers in the response.

2. Open your site in Chrome or Firefox
3. Open Developer Tools
4. Choose the Network tab
5. Refresh the page
6. Select any request
7. In Response Headers, verify that `Report-To` and `NEL` are present

## Sampling Configuration

The `success_fraction` and `failure_fraction` parameters control what percentage of reports browsers send:

- `failure_fraction` sets the proportion of failed requests reported (0.0 to 1.0). Higher values give more visibility into errors and increase report volume.
- `success_fraction` sets the proportion of successful requests reported (0.0 to 1.0). Successful reports help establish baselines and generate high volume on busy sites.

A lower `success_fraction` reduces ingestion costs and noise while still capturing error data. A higher `failure_fraction` increases the likelihood of capturing errors when they occur. Adjust both to match your traffic volume and observability requirements.

See the [W3C NEL specification](https://w3c.github.io/network-error-logging/#nel-response-header) for full parameter details.

## Conclusion

After configuring NEL headers and verifying they appear in responses, browsers visiting your site will begin reporting network errors to your pipeline. Check the [Monitoring](monitoring.md) dashboard to confirm reports are flowing, and use [Athena Queries](athena-queries.md) for historical analysis.
