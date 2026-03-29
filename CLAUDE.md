# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An F# webhook reverse proxy that receives incoming webhook HTTP requests, optionally verifies their signatures, and forwards them to configured backend targets. Built on ASP.NET Core / Kestrel. Configuration is YAML-driven. Signature verification is informational only — requests are always proxied regardless of verification result.

## Build & Run

```bash
dotnet build src/WebhookProxy.fsproj                  # Build
dotnet run --project src/WebhookProxy.fsproj           # Run (uses config.yaml by default)
CONFIG_PATH=config.dev.yaml dotnet run --project src   # Override config file
dotnet test tests/WebhookProxy.Tests.fsproj            # Run all tests
dotnet test tests --filter "FullyQualifiedName~Verify" # Run tests for a module
```

### Docker (local dev)

```bash
docker compose up --build            # Starts proxy + echo-server (uses config.dev.yaml)
```

The echo-server at port 3333 mirrors all received requests for debugging.

## Architecture

The request flow is: `Program.fs` (Kestrel HTTP server + graceful shutdown) -> `Proxy.handleRequest` (route matching) -> optional signature verification -> `HttpClient`-based reverse proxy to target.

**Four modules in `src/`:**

- **`Config`** — Loads and validates YAML config via YamlDotNet. Routes map an incoming `path` to a `target` URL. Routes can optionally specify `verify_signature` (type + secret env var name) or be a `health_check` endpoint. Returns `Result<ValidatedConfig, string>`.
- **`Proxy`** — Core HTTP handler. Iterates `RouteEntry` list for path matching (exact or prefix). Health check routes return JSON status with concurrent target probing via `Task.WhenAll`. Non-health routes proxy via `HttpClient` with header forwarding.
- **`Verify`** — `Verifier` type alias (`byte[] -> IHeaderDictionary -> VerifyResult`) using a discriminated union (`Valid | Invalid | VerifyError of string`). Implementations: GitHub (HMAC-SHA256 via `X-Hub-Signature-256`) and Stripe (HMAC-SHA256 via `Stripe-Signature` with timestamp). Factory function `create` returns the correct verifier.
- **`Logger`** — Minimal structured JSON logger writing one JSON object per line to a TextWriter. Thread-safe via `lock`.

## Key Design Decisions

- **Signature verification is pass-through**: verification results are logged but never block proxying. The `bool option` pattern (`None` = no verifier, `Some true/false` = result) threads through for logging.
- **Secrets come from environment variables**: `SignatureConfig.SecretEnv` names the env var, not the secret itself. The proxy reads `Environment.GetEnvironmentVariable(secretEnv)` at startup.
- **Minimal external dependencies**: only YamlDotNet beyond the ASP.NET Core framework. The logger, proxy, and verifiers use framework types.
- **Route matching is prefix-based**: `/github` matches `/github` and `/github/events` etc.
- **Idiomatic F#**: discriminated unions for verify results, Result types for config loading, modules over classes, pipeline operators, immutable data.

## Config Structure

See `config.yaml` for production config, `config.dev.yaml` for local docker dev. Key fields on routes: `path`, `target`, `description`, `health_check` (bool), `verify_signature` (optional, with `type` and `secret_env`). Supported verifier types: `github`, `stripe`.
