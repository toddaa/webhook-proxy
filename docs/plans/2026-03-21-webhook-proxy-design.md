# Webhook Proxy — Design Document

**Date:** 2026-03-21

## Overview

A lightweight HTTP webhook proxy service in Go (standard library + `gopkg.in/yaml.v3`). Receives inbound webhooks from external services via a single public endpoint and routes them to internal services on a private network based on a YAML routing table. Designed to run as a Docker container behind any tunnel provider (Cloudflare Tunnel, ngrok, etc.) but has no tunnel-specific logic.

## Architecture

```
External Service (GitHub, Stripe, EAS, etc.)
  → Tunnel (Cloudflare, ngrok, etc.)
    → Webhook Proxy (this service, Docker container on private network)
      → Internal Service (n8n, local APIs, etc.)
```

## Config & Routing

- Config file (`config.yaml`) parsed at startup using `gopkg.in/yaml.v3`
- Defines `server.port` (default 8080), `server.request_timeout` (default 30s)
- `routes[]` — each with `path`, `target`, `description`, optional `verify_signature` (type + secret_env), optional `health_check: true`
- Route matching: iterate routes in order, match by path prefix, first match wins
- Extra path segments after the prefix are appended to the target URL (e.g., `/github/push` → `target/push`)
- No match → 404 JSON error
- Health check route (`health_check: true`) is handled directly, not forwarded
- Validation at startup: reject duplicate paths, missing targets on non-health-check routes, unknown signature verification types — fail fast

## Request Proxying

- Per-route `httputil.ReverseProxy` instances created at startup
- Each gets a `Director` function that rewrites the request URL to the route's target, appends extra path segments, and injects custom headers:
  - `X-Forwarded-For` (handled by ReverseProxy)
  - `X-Webhook-Proxy-Route` — the matched route path
  - `X-Webhook-Proxy-Timestamp` — when the proxy received the request
- Body is read into a buffer first (for signature verification), then restored before proxying — byte-for-byte fidelity
- Error handling via `ErrorHandler` callback:
  - Target unreachable → 502 JSON
  - Timeout → 504 JSON
- Request timeout from `server.request_timeout` config applied via HTTP client transport

## Signature Verification

- Interface-based design:
  ```go
  type SignatureVerifier interface {
      Verify(body []byte, headers http.Header) (bool, error)
  }
  ```
- Two implementations: `GitHubVerifier` (HMAC-SHA256, `X-Hub-Signature-256` header) and `StripeVerifier` (Stripe-Signature header, `v1` scheme, HMAC-SHA256)
- Secrets read from environment variables specified in `secret_env` config
- Constant-time comparison via `hmac.Equal`
- Verification runs before proxying; result is logged
- Request is always proxied regardless of verification result (informational only)
- Adding a new provider: implement the interface, register the type string in the factory

## Health Check

- Route with `health_check: true` handled directly
- Returns 200 with JSON:
  ```json
  {
    "status": "ok",
    "routes": 3,
    "uptime": "2h15m30s",
    "targets": {
      "/github": {"status": "up", "response_time_ms": 12},
      "/eas": {"status": "down", "error": "connection refused"},
      "/stripe": {"status": "up", "response_time_ms": 45}
    }
  }
  ```
- Active checking: GET each non-health-check route's target with 5s timeout
- `up` if 2xx response, `down` otherwise with error message
- Overall `status` is `"ok"` as long as the proxy is running — individual target failures don't affect it

## Logging

- Structured JSON to stdout (Docker/CloudWatch compatible)
- Every request logged: timestamp, method, path, matched route, response status, duration, signature result
- Errors include context (connection refused, timeout, etc.)
- Startup and shutdown events logged
- No log levels — everything is logged

## Error Handling

All error responses are structured JSON: `{"error": "...", "code": <status>}`

| Scenario | Status | Code |
|----------|--------|------|
| No matching route | 404 | `no matching route` |
| Signature verification failure | 401 | Reserved for future gatekeeper mode |
| Target unreachable | 502 | Bad Gateway |
| Request timeout | 504 | Gateway Timeout |

## Graceful Shutdown

- Signal handler for SIGINT/SIGTERM
- `http.Server.Shutdown()` with 15s timeout to drain in-flight requests
- Startup and shutdown events logged

## Project Structure

```
webhook-proxy/
├── main.go              # Entry point, server setup, signal handling
├── config/
│   └── config.go        # YAML config loading and validation
├── proxy/
│   └── proxy.go         # Route matching, per-route ReverseProxy setup
├── verify/
│   ├── verifier.go      # SignatureVerifier interface + factory
│   ├── github.go        # GitHub HMAC-SHA256
│   └── stripe.go        # Stripe v1 signature
├── logger/
│   └── logger.go        # Structured JSON logger
├── config.yaml          # Example configuration
├── Dockerfile           # Multi-stage build
├── docker-compose.yaml  # Proxy + echo server for testing
├── go.mod
└── go.sum
```

## Containerization

- **Dockerfile:** Multi-stage build. Stage 1: `golang:1.22-alpine`, static binary with `CGO_ENABLED=0`. Stage 2: `alpine:latest`, non-root user, expose 8080. Config mounted as volume.
- **docker-compose.yaml:** Proxy + echo server for end-to-end testing

## Testing

- Unit tests using `testing` + `net/http/httptest` (no third-party frameworks):
  - `verify/` — GitHub and Stripe verification with known-good/bad signatures
  - `config/` — YAML parsing, validation (duplicates, missing targets, unknown types)
  - `proxy/` — route matching (exact, prefix with extra path, no match)
- Integration test via docker-compose: proxy + echo server, verify headers/body forwarding, health check reporting

## Future Considerations (not built, but designed for)

- Web UI for viewing/replaying webhook deliveries
- Async mode with queuing and retry
- Rate limiting per route
- Prometheus metrics endpoint
- Hot-reload of config file
