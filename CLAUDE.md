# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Go webhook reverse proxy that receives incoming webhook HTTP requests, optionally verifies their signatures, and forwards them to configured backend targets. Configuration is YAML-driven. Signature verification is informational only — requests are always proxied regardless of verification result.

## Build & Run

```bash
go build -o webhook-proxy .          # Build binary
go run .                             # Run directly (uses config.yaml by default)
CONFIG_PATH=config.dev.yaml go run . # Override config file
go test ./...                        # Run all tests
go test ./verify                     # Run tests for a single package
go test -run TestGitHub ./verify     # Run a specific test
```

### Docker (local dev)

```bash
docker compose up --build            # Starts proxy + echo-server (uses config.dev.yaml)
```

The echo-server at port 3333 mirrors all received requests for debugging.

## Architecture

The request flow is: `main.go` (HTTP server + graceful shutdown) → `proxy.Handler.ServeHTTP` (route matching) → optional signature verification → `httputil.ReverseProxy` to target.

**Four packages:**

- **`config`** — Loads and validates YAML config. Routes map an incoming `path` to a `target` URL. Routes can optionally specify `verify_signature` (type + secret env var name) or be a `health_check` endpoint.
- **`proxy`** — Core HTTP handler. Iterates `routeEntry` list for path matching (exact or prefix). Health check routes return JSON status with concurrent target probing. Non-health routes proxy via `httputil.ReverseProxy` with a custom `Director`.
- **`verify`** — `SignatureVerifier` interface with `Verify(body, headers) (bool, error)`. Implementations: `GitHubVerifier` (HMAC-SHA256 via `X-Hub-Signature-256`) and `StripeVerifier` (HMAC-SHA256 via `Stripe-Signature` with timestamp). Factory function `New(type, secret)` returns the correct verifier.
- **`logger`** — Minimal structured JSON logger writing one JSON object per line to stdout. Thread-safe via mutex.

## Key Design Decisions

- **Signature verification is pass-through**: verification results are logged but never block proxying. The `sigResult *bool` pattern (nil = no verifier, true/false = result) threads through for logging.
- **Secrets come from environment variables**: `SignatureConfig.SecretEnv` names the env var, not the secret itself. The proxy reads `os.Getenv(secretEnv)` at startup.
- **No external dependencies beyond `gopkg.in/yaml.v3`**: the logger, proxy, and verifiers use only the standard library.
- **Route matching is prefix-based**: `/github` matches `/github` and `/github/events` etc.

## Config Structure

See `config.yaml` for production config, `config.dev.yaml` for local docker dev. Key fields on routes: `path`, `target`, `description`, `health_check` (bool), `verify_signature` (optional, with `type` and `secret_env`). Supported verifier types: `github`, `stripe`.
