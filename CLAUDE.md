# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript webhook reverse proxy that receives incoming webhook HTTP requests, optionally verifies their signatures, and forwards them to configured backend targets. Configuration is YAML-driven. Signature verification is informational only — requests are always proxied regardless of verification result.

## Build & Run

```bash
npm install                          # Install dependencies
npm run build                        # Compile TypeScript to dist/
npm start                            # Run compiled output (uses config.yaml by default)
CONFIG_PATH=config.dev.yaml npm start # Override config file
npm test                             # Run all tests
npm run dev                          # Run with tsx (no build step, requires tsx)
```

### Docker (local dev)

```bash
docker compose up --build            # Starts proxy + echo-server (uses config.dev.yaml)
```

The echo-server at port 3333 mirrors all received requests for debugging.

## Architecture

The request flow is: `src/main.ts` (HTTP server + graceful shutdown) → `Handler.handleRequest` (route matching) → optional signature verification → `http-proxy` to target.

**Four modules:**

- **`src/config/`** — Loads and validates YAML config. Routes map an incoming `path` to a `target` URL. Routes can optionally specify `verify_signature` (type + secret env var name) or be a `health_check` endpoint.
- **`src/proxy/`** — Core HTTP handler. Iterates route entries for path matching (exact or prefix). Health check routes return JSON status with concurrent target probing. Non-health routes proxy via `http-proxy` with path rewriting.
- **`src/verify/`** — `SignatureVerifier` interface with `verify(body, headers)` returning `{valid, error?}`. Implementations: `GitHubVerifier` (HMAC-SHA256 via `X-Hub-Signature-256`) and `StripeVerifier` (HMAC-SHA256 via `Stripe-Signature` with timestamp). Factory function `createVerifier(type, secret)` returns the correct verifier.
- **`src/logger/`** — Minimal structured JSON logger writing one JSON object per line to a writable stream. Thread-safe by nature in Node.js single-threaded model.

## Key Design Decisions

- **Signature verification is pass-through**: verification results are logged but never block proxying. The `sigResult: boolean | null` pattern (null = no verifier, true/false = result) threads through for logging.
- **Secrets come from environment variables**: `verify_signature.secret_env` names the env var, not the secret itself. The proxy reads `process.env[secretEnv]` at startup.
- **Minimal dependencies**: only `yaml` for YAML parsing and `http-proxy` for reverse proxying. Tests use `vitest`.
- **Route matching is prefix-based**: `/github` matches `/github` and `/github/events` etc.

## Config Structure

See `config.yaml` for production config, `config.dev.yaml` for local docker dev. Key fields on routes: `path`, `target`, `description`, `health_check` (bool), `verify_signature` (optional, with `type` and `secret_env`). Supported verifier types: `github`, `stripe`.
