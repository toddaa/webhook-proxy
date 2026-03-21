# Webhook Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an HTTP webhook proxy in Go that routes inbound webhooks to internal services based on a YAML config, with signature verification, active health checking, structured logging, and graceful shutdown.

**Architecture:** Single Go binary using `net/http` for the server and `net/http/httputil.ReverseProxy` for forwarding. Routes are defined in `config.yaml` (parsed with `gopkg.in/yaml.v3`). Each route gets its own ReverseProxy instance at startup. Signature verification is interface-based and informational (log only). Runs as a Docker container.

**Tech Stack:** Go 1.22+, standard library, `gopkg.in/yaml.v3`, Docker multi-stage build

---

### Task 1: Project Scaffolding

**Files:**
- Create: `go.mod`
- Create: `main.go` (placeholder)

**Step 1: Initialize Go module**

Run:
```bash
go mod init github.com/bergwerk/webhook-proxy
```

**Step 2: Create placeholder main.go**

```go
package main

import "fmt"

func main() {
	fmt.Println("webhook-proxy starting...")
}
```

**Step 3: Verify it compiles and runs**

Run: `go run main.go`
Expected: `webhook-proxy starting...`

**Step 4: Commit**

```bash
git add go.mod main.go
git commit -m "feat: scaffold Go project with module and placeholder main"
```

---

### Task 2: Structured JSON Logger

**Files:**
- Create: `logger/logger.go`
- Test: `logger/logger_test.go`

**Step 1: Write the failing test**

```go
package logger

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestLogOutputIsJSON(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	log.Log(map[string]any{
		"event":   "test",
		"message": "hello",
	})

	var parsed map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}

	if parsed["event"] != "test" {
		t.Errorf("expected event=test, got %v", parsed["event"])
	}
	if parsed["message"] != "hello" {
		t.Errorf("expected message=hello, got %v", parsed["message"])
	}
	if _, ok := parsed["timestamp"]; !ok {
		t.Error("expected timestamp field to be present")
	}
}

func TestLogAddsTimestamp(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	log.Log(map[string]any{"event": "test"})

	var parsed map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}

	ts, ok := parsed["timestamp"].(string)
	if !ok || ts == "" {
		t.Error("timestamp should be a non-empty string")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./logger/ -v`
Expected: FAIL — package doesn't exist yet

**Step 3: Write minimal implementation**

```go
package logger

import (
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Logger writes structured JSON log entries to an io.Writer.
// Each call to Log produces one JSON object per line on the writer.
type Logger struct {
	writer io.Writer
	mu     sync.Mutex // protects concurrent writes
}

// New creates a Logger that writes to the given writer.
func New(w io.Writer) *Logger {
	return &Logger{writer: w}
}

// NewStdout creates a Logger that writes to os.Stdout.
func NewStdout() *Logger {
	return New(os.Stdout)
}

// Log writes a single JSON log entry. It automatically adds a "timestamp"
// field with the current time in RFC3339 format. The fields map is merged
// into the output — any key called "timestamp" in fields will be overwritten.
func (l *Logger) Log(fields map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Add timestamp
	fields["timestamp"] = time.Now().UTC().Format(time.RFC3339)

	data, err := json.Marshal(fields)
	if err != nil {
		// Fallback: log the error itself
		fallback, _ := json.Marshal(map[string]any{
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"event":     "log_error",
			"error":     err.Error(),
		})
		l.writer.Write(fallback)
		l.writer.Write([]byte("\n"))
		return
	}

	l.writer.Write(data)
	l.writer.Write([]byte("\n"))
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./logger/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add logger/
git commit -m "feat: add structured JSON logger with tests"
```

---

### Task 3: Config Loading & Validation

**Files:**
- Create: `config/config.go`
- Test: `config/config_test.go`
- Create: `config.yaml` (example config)

**Step 1: Write the failing tests**

```go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadValidConfig(t *testing.T) {
	yaml := `
server:
  port: 9090
  request_timeout: 15s
routes:
  - path: /github
    target: http://localhost:5678/webhook/github
    description: "GitHub webhooks"
  - path: /health
    target: ""
    description: "Health check"
    health_check: true
`
	path := writeTempFile(t, yaml)
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Server.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Server.Port)
	}
	if cfg.Server.RequestTimeout.String() != "15s" {
		t.Errorf("expected timeout 15s, got %s", cfg.Server.RequestTimeout)
	}
	if len(cfg.Routes) != 2 {
		t.Fatalf("expected 2 routes, got %d", len(cfg.Routes))
	}
	if cfg.Routes[0].Path != "/github" {
		t.Errorf("expected path /github, got %s", cfg.Routes[0].Path)
	}
}

func TestLoadDefaults(t *testing.T) {
	yaml := `
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
`
	path := writeTempFile(t, yaml)
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.RequestTimeout.String() != "30s" {
		t.Errorf("expected default timeout 30s, got %s", cfg.Server.RequestTimeout)
	}
}

func TestValidationDuplicatePaths(t *testing.T) {
	yaml := `
routes:
  - path: /test
    target: http://localhost:8080
    description: "test1"
  - path: /test
    target: http://localhost:8081
    description: "test2"
`
	path := writeTempFile(t, yaml)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for duplicate paths")
	}
}

func TestValidationMissingTarget(t *testing.T) {
	yaml := `
routes:
  - path: /test
    target: ""
    description: "missing target"
`
	path := writeTempFile(t, yaml)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for missing target on non-health-check route")
	}
}

func TestValidationUnknownVerifierType(t *testing.T) {
	yaml := `
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
    verify_signature:
      type: unknown_provider
      secret_env: SECRET
`
	path := writeTempFile(t, yaml)
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for unknown verifier type")
	}
}

func TestValidationHealthCheckAllowsEmptyTarget(t *testing.T) {
	yaml := `
routes:
  - path: /health
    target: ""
    description: "health"
    health_check: true
`
	path := writeTempFile(t, yaml)
	_, err := Load(path)
	if err != nil {
		t.Fatalf("health check should allow empty target, got: %v", err)
	}
}

func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}
	return path
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./config/ -v`
Expected: FAIL — package doesn't exist yet

**Step 3: Write the implementation**

```go
package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration structure parsed from config.yaml.
type Config struct {
	Server ServerConfig `yaml:"server"`
	Routes []Route      `yaml:"routes"`
}

// ServerConfig holds server-level settings.
type ServerConfig struct {
	Port           int           `yaml:"port"`
	RequestTimeout time.Duration `yaml:"request_timeout"`
}

// Route defines a single webhook route: an incoming path mapped to a target URL.
type Route struct {
	Path            string           `yaml:"path"`
	Target          string           `yaml:"target"`
	Description     string           `yaml:"description"`
	HealthCheck     bool             `yaml:"health_check"`
	VerifySignature *SignatureConfig `yaml:"verify_signature"`
}

// SignatureConfig holds the configuration for webhook signature verification.
type SignatureConfig struct {
	Type      string `yaml:"type"`
	SecretEnv string `yaml:"secret_env"`
}

// knownVerifierTypes lists the signature verification types we support.
var knownVerifierTypes = map[string]bool{
	"github": true,
	"stripe": true,
}

// Load reads and parses a YAML config file, applies defaults, and validates.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	applyDefaults(cfg)

	if err := validate(cfg); err != nil {
		return nil, fmt.Errorf("config validation: %w", err)
	}

	return cfg, nil
}

// applyDefaults sets default values for any fields not specified in the config.
func applyDefaults(cfg *Config) {
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8080
	}
	if cfg.Server.RequestTimeout == 0 {
		cfg.Server.RequestTimeout = 30 * time.Second
	}
}

// validate checks the config for logical errors.
func validate(cfg *Config) error {
	seen := make(map[string]bool)
	for _, r := range cfg.Routes {
		if seen[r.Path] {
			return fmt.Errorf("duplicate route path: %s", r.Path)
		}
		seen[r.Path] = true

		if !r.HealthCheck && r.Target == "" {
			return fmt.Errorf("route %s: target is required for non-health-check routes", r.Path)
		}

		if r.VerifySignature != nil {
			if !knownVerifierTypes[r.VerifySignature.Type] {
				return fmt.Errorf("route %s: unknown signature verification type: %s", r.Path, r.VerifySignature.Type)
			}
		}
	}
	return nil
}
```

**Step 4: Install yaml dependency and run tests**

Run:
```bash
go get gopkg.in/yaml.v3
go test ./config/ -v
```
Expected: PASS

**Step 5: Create example config.yaml**

```yaml
server:
  port: 8080
  request_timeout: 30s

routes:
  - path: /github
    target: http://192.168.1.50:5678/webhook/github
    description: "GitHub webhooks → n8n"
    verify_signature:
      type: github
      secret_env: GITHUB_WEBHOOK_SECRET

  - path: /eas
    target: http://192.168.1.50:5678/webhook/eas
    description: "Expo EAS Build webhooks → n8n"

  - path: /stripe
    target: http://192.168.1.60:3000/api/hooks/stripe
    description: "Stripe webhooks → billing service"
    verify_signature:
      type: stripe
      secret_env: STRIPE_WEBHOOK_SECRET

  - path: /health
    target: ""
    description: "Health check endpoint"
    health_check: true
```

**Step 6: Commit**

```bash
git add config/ config.yaml go.mod go.sum
git commit -m "feat: add config loading with YAML parsing and validation"
```

---

### Task 4: Signature Verification — Interface & GitHub

**Files:**
- Create: `verify/verifier.go`
- Create: `verify/github.go`
- Create: `verify/stripe.go` (stub for compilation)
- Test: `verify/github_test.go`

**Step 1: Write the failing test**

```go
package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
)

func TestGitHubVerifyValidSignature(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"action":"push"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	v := NewGitHubVerifier(secret)
	headers := http.Header{}
	headers.Set("X-Hub-Signature-256", sig)

	valid, err := v.Verify(body, headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Error("expected signature to be valid")
	}
}

func TestGitHubVerifyInvalidSignature(t *testing.T) {
	v := NewGitHubVerifier("test-secret")
	headers := http.Header{}
	headers.Set("X-Hub-Signature-256", "sha256=invalid")

	valid, err := v.Verify([]byte(`{"action":"push"}`), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Error("expected signature to be invalid")
	}
}

func TestGitHubVerifyMissingHeader(t *testing.T) {
	v := NewGitHubVerifier("test-secret")
	headers := http.Header{}

	valid, err := v.Verify([]byte(`{"action":"push"}`), headers)
	if err == nil {
		t.Fatal("expected error for missing header")
	}
	if valid {
		t.Error("expected valid to be false")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./verify/ -v`
Expected: FAIL — package doesn't exist yet

**Step 3: Write the interface, GitHub implementation, and Stripe stub**

`verify/verifier.go`:
```go
package verify

import "fmt"

// SignatureVerifier verifies webhook signatures.
// Each provider (GitHub, Stripe, etc.) implements this interface.
type SignatureVerifier interface {
	Verify(body []byte, headers http.Header) (bool, error)
}

// New creates a SignatureVerifier for the given provider type and secret.
func New(verifierType, secret string) (SignatureVerifier, error) {
	switch verifierType {
	case "github":
		return NewGitHubVerifier(secret), nil
	case "stripe":
		return NewStripeVerifier(secret), nil
	default:
		return nil, fmt.Errorf("unknown verifier type: %s", verifierType)
	}
}
```

`verify/github.go`:
```go
package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// GitHubVerifier verifies GitHub webhook signatures using HMAC-SHA256.
// GitHub sends the signature in the X-Hub-Signature-256 header as "sha256=<hex>".
type GitHubVerifier struct {
	secret []byte
}

func NewGitHubVerifier(secret string) *GitHubVerifier {
	return &GitHubVerifier{secret: []byte(secret)}
}

func (v *GitHubVerifier) Verify(body []byte, headers http.Header) (bool, error) {
	sigHeader := headers.Get("X-Hub-Signature-256")
	if sigHeader == "" {
		return false, fmt.Errorf("missing X-Hub-Signature-256 header")
	}

	if !strings.HasPrefix(sigHeader, "sha256=") {
		return false, fmt.Errorf("invalid signature format: expected sha256= prefix")
	}

	sigHex := strings.TrimPrefix(sigHeader, "sha256=")
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return false, fmt.Errorf("invalid signature hex: %w", err)
	}

	mac := hmac.New(sha256.New, v.secret)
	mac.Write(body)
	expected := mac.Sum(nil)

	// Constant-time comparison to prevent timing attacks
	return hmac.Equal(sigBytes, expected), nil
}
```

`verify/stripe.go` (stub):
```go
package verify

import (
	"fmt"
	"net/http"
)

type StripeVerifier struct {
	secret []byte
}

func NewStripeVerifier(secret string) *StripeVerifier {
	return &StripeVerifier{secret: []byte(secret)}
}

func (v *StripeVerifier) Verify(body []byte, headers http.Header) (bool, error) {
	return false, fmt.Errorf("stripe verification not yet implemented")
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./verify/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add verify/
git commit -m "feat: add signature verification interface and GitHub HMAC-SHA256 verifier"
```

---

### Task 5: Signature Verification — Stripe

**Files:**
- Modify: `verify/stripe.go` (replace stub)
- Test: `verify/stripe_test.go`

**Step 1: Write the failing test**

```go
package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestStripeVerifyValidSignature(t *testing.T) {
	secret := "whsec_test_secret"
	body := []byte(`{"type":"charge.succeeded"}`)
	timestamp := fmt.Sprintf("%d", time.Now().Unix())

	signed := timestamp + "." + string(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	sig := hex.EncodeToString(mac.Sum(nil))

	header := fmt.Sprintf("t=%s,v1=%s", timestamp, sig)

	v := NewStripeVerifier(secret)
	headers := http.Header{}
	headers.Set("Stripe-Signature", header)

	valid, err := v.Verify(body, headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Error("expected signature to be valid")
	}
}

func TestStripeVerifyInvalidSignature(t *testing.T) {
	v := NewStripeVerifier("whsec_test_secret")
	headers := http.Header{}
	headers.Set("Stripe-Signature", "t=12345,v1=invalidsig")

	valid, err := v.Verify([]byte(`{"type":"charge.succeeded"}`), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Error("expected signature to be invalid")
	}
}

func TestStripeVerifyMissingHeader(t *testing.T) {
	v := NewStripeVerifier("whsec_test_secret")
	headers := http.Header{}

	valid, err := v.Verify([]byte(`{}`), headers)
	if err == nil {
		t.Fatal("expected error for missing header")
	}
	if valid {
		t.Error("expected valid to be false")
	}
}

func TestStripeVerifyMalformedHeader(t *testing.T) {
	v := NewStripeVerifier("whsec_test_secret")
	headers := http.Header{}
	headers.Set("Stripe-Signature", "garbage")

	valid, err := v.Verify([]byte(`{}`), headers)
	if err == nil {
		t.Fatal("expected error for malformed header")
	}
	if valid {
		t.Error("expected valid to be false")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./verify/ -v -run TestStripe`
Expected: FAIL — stub returns error

**Step 3: Replace the stub with full implementation**

`verify/stripe.go`:
```go
package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// StripeVerifier verifies Stripe webhook signatures.
// Stripe sends signatures in the Stripe-Signature header with format:
// "t=<timestamp>,v1=<signature>[,v1=<signature>...]"
// The signature is HMAC-SHA256 of "<timestamp>.<body>".
type StripeVerifier struct {
	secret []byte
}

func NewStripeVerifier(secret string) *StripeVerifier {
	return &StripeVerifier{secret: []byte(secret)}
}

func (v *StripeVerifier) Verify(body []byte, headers http.Header) (bool, error) {
	sigHeader := headers.Get("Stripe-Signature")
	if sigHeader == "" {
		return false, fmt.Errorf("missing Stripe-Signature header")
	}

	var timestamp string
	var signatures []string

	parts := strings.Split(sigHeader, ",")
	for _, part := range parts {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			timestamp = kv[1]
		case "v1":
			signatures = append(signatures, kv[1])
		}
	}

	if timestamp == "" || len(signatures) == 0 {
		return false, fmt.Errorf("malformed Stripe-Signature header: missing timestamp or v1 signature")
	}

	signed := timestamp + "." + string(body)
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(signed))
	expected := mac.Sum(nil)

	for _, sig := range signatures {
		sigBytes, err := hex.DecodeString(sig)
		if err != nil {
			continue
		}
		if hmac.Equal(sigBytes, expected) {
			return true, nil
		}
	}

	return false, nil
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./verify/ -v`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add verify/
git commit -m "feat: add Stripe signature verification"
```

---

### Task 6: Proxy — Route Matching & Request Forwarding

**Files:**
- Create: `proxy/proxy.go`
- Test: `proxy/proxy_test.go`

**Step 1: Write the failing tests**

```go
package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bergwerk/webhook-proxy/config"
	"github.com/bergwerk/webhook-proxy/logger"
)

func TestRouteMatchExact(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("path=" + r.URL.Path))
	}))
	defer backend.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/github", Target: backend.URL + "/webhook/github", Description: "test"},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("POST", "/github", strings.NewReader(`{"test":true}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "path=/webhook/github") {
		t.Errorf("expected path=/webhook/github, got %s", rec.Body.String())
	}
}

func TestRouteMatchWithExtraPath(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("path=" + r.URL.Path))
	}))
	defer backend.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/github", Target: backend.URL + "/webhook/github", Description: "test"},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("POST", "/github/push", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "path=/webhook/github/push") {
		t.Errorf("expected path=/webhook/github/push, got %s", rec.Body.String())
	}
}

func TestRouteNoMatch(t *testing.T) {
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/github", Target: "http://localhost:9999", Description: "test"},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("POST", "/unknown", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestProxyPreservesHeaders(t *testing.T) {
	var receivedHeaders http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/test", Target: backend.URL, Description: "test"},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("POST", "/test", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Custom-Header", "custom-value")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if receivedHeaders.Get("Content-Type") != "application/json" {
		t.Error("Content-Type header not preserved")
	}
	if receivedHeaders.Get("X-Custom-Header") != "custom-value" {
		t.Error("X-Custom-Header not preserved")
	}
	if receivedHeaders.Get("X-Webhook-Proxy-Route") != "/test" {
		t.Error("X-Webhook-Proxy-Route header not set")
	}
	if receivedHeaders.Get("X-Webhook-Proxy-Timestamp") == "" {
		t.Error("X-Webhook-Proxy-Timestamp header not set")
	}
}

func TestProxyPreservesBody(t *testing.T) {
	var receivedBody string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		receivedBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/test", Target: backend.URL, Description: "test"},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	body := `{"event":"push","ref":"refs/heads/main"}`
	req := httptest.NewRequest("POST", "/test", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if receivedBody != body {
		t.Errorf("body not preserved: expected %q, got %q", body, receivedBody)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./proxy/ -v`
Expected: FAIL — package doesn't exist yet

**Step 3: Write the implementation**

```go
package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/bergwerk/webhook-proxy/config"
	"github.com/bergwerk/webhook-proxy/logger"
	"github.com/bergwerk/webhook-proxy/verify"
)

// routeEntry holds a compiled route: the config plus the reverse proxy and
// optional signature verifier.
type routeEntry struct {
	config   config.Route
	proxy    *httputil.ReverseProxy
	verifier verify.SignatureVerifier
}

// Handler is the main HTTP handler that matches incoming requests to routes
// and forwards them to their targets via reverse proxy.
type Handler struct {
	routes    []routeEntry
	cfg       *config.Config
	log       *logger.Logger
	startTime time.Time
}

// NewHandler creates a Handler from the given config. It creates a
// ReverseProxy instance for each non-health-check route.
func NewHandler(cfg *config.Config, log *logger.Logger) *Handler {
	h := &Handler{
		cfg:       cfg,
		log:       log,
		startTime: time.Now(),
	}

	for _, route := range cfg.Routes {
		entry := routeEntry{config: route}

		if !route.HealthCheck {
			targetURL, _ := url.Parse(route.Target)
			entry.proxy = &httputil.ReverseProxy{
				Director: makeDirector(targetURL, route.Path),
				ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
					writeJSONError(w, fmt.Sprintf("proxy error: %v", err), http.StatusBadGateway)
				},
			}
		}

		// Set up signature verifier if configured
		if route.VerifySignature != nil {
			secret := os.Getenv(route.VerifySignature.SecretEnv)
			if v, err := verify.New(route.VerifySignature.Type, secret); err == nil {
				entry.verifier = v
			}
		}

		h.routes = append(h.routes, entry)
	}

	return h
}

// ServeHTTP matches the request to a route and proxies it, or returns an error.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	for _, entry := range h.routes {
		if !matchRoute(r.URL.Path, entry.config.Path) {
			continue
		}

		// Health check — handle directly
		if entry.config.HealthCheck {
			h.handleHealthCheck(w, r)
			h.logRequest(r, entry.config.Path, http.StatusOK, time.Since(start), nil)
			return
		}

		// Read body for signature verification (and restore it for proxying)
		var bodyBytes []byte
		var sigResult *bool
		if r.Body != nil {
			bodyBytes, _ = io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		}

		// Signature verification (informational only)
		if entry.verifier != nil && bodyBytes != nil {
			valid, err := entry.verifier.Verify(bodyBytes, r.Header)
			sigResult = &valid
			if err != nil {
				h.log.Log(map[string]any{
					"event": "signature_error",
					"route": entry.config.Path,
					"error": err.Error(),
				})
			}
		}

		// Proxy the request
		entry.proxy.ServeHTTP(w, r)
		h.logRequest(r, entry.config.Path, 0, time.Since(start), sigResult)
		return
	}

	// No matching route
	writeJSONError(w, "no matching route", http.StatusNotFound)
	h.logRequest(r, "", http.StatusNotFound, time.Since(start), nil)
}

// matchRoute checks if the request path matches the route path as a prefix.
func matchRoute(reqPath, routePath string) bool {
	if reqPath == routePath {
		return true
	}
	return strings.HasPrefix(reqPath, routePath+"/")
}

// makeDirector returns a Director function for httputil.ReverseProxy.
func makeDirector(target *url.URL, routePath string) func(*http.Request) {
	return func(r *http.Request) {
		extra := strings.TrimPrefix(r.URL.Path, routePath)
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		r.URL.Path = target.Path + extra
		r.Host = target.Host

		r.Header.Set("X-Webhook-Proxy-Route", routePath)
		r.Header.Set("X-Webhook-Proxy-Timestamp", time.Now().UTC().Format(time.RFC3339))
	}
}

// handleHealthCheck responds with the proxy's health status.
func (h *Handler) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	routeCount := 0
	targets := make(map[string]any)
	client := &http.Client{Timeout: 5 * time.Second}

	for _, entry := range h.routes {
		if entry.config.HealthCheck {
			continue
		}
		routeCount++

		start := time.Now()
		resp, err := client.Get(entry.config.Target)
		elapsed := time.Since(start).Milliseconds()

		if err != nil {
			targets[entry.config.Path] = map[string]any{
				"status": "down",
				"error":  err.Error(),
			}
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			targets[entry.config.Path] = map[string]any{
				"status":           "up",
				"response_time_ms": elapsed,
			}
		} else {
			targets[entry.config.Path] = map[string]any{
				"status": "down",
				"error":  fmt.Sprintf("HTTP %d", resp.StatusCode),
			}
		}
	}

	uptime := time.Since(h.startTime).Round(time.Second).String()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"routes":  routeCount,
		"uptime":  uptime,
		"targets": targets,
	})
}

// logRequest logs a request with the structured logger.
func (h *Handler) logRequest(r *http.Request, route string, status int, duration time.Duration, sigResult *bool) {
	fields := map[string]any{
		"event":       "request",
		"method":      r.Method,
		"path":        r.URL.Path,
		"route":       route,
		"duration_ms": duration.Milliseconds(),
	}
	if status != 0 {
		fields["status"] = status
	}
	if sigResult != nil {
		fields["signature_valid"] = *sigResult
	}
	h.log.Log(fields)
}

// writeJSONError writes a structured JSON error response.
func writeJSONError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{
		"error": message,
		"code":  code,
	})
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./proxy/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add proxy/
git commit -m "feat: add route matching and reverse proxy handler"
```

---

### Task 7: Health Check Tests

**Files:**
- Modify: `proxy/proxy_test.go` (add health check tests)

**Step 1: Add health check tests**

Append to `proxy/proxy_test.go`:
```go
func TestHealthCheckEndpoint(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/test", Target: backend.URL, Description: "test backend"},
			{Path: "/health", Target: "", Description: "health", HealthCheck: true},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON response: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %v", body["status"])
	}
	if body["routes"] != float64(1) {
		t.Errorf("expected routes=1, got %v", body["routes"])
	}

	targets, ok := body["targets"].(map[string]any)
	if !ok {
		t.Fatal("expected targets to be a map")
	}
	testTarget, ok := targets["/test"].(map[string]any)
	if !ok {
		t.Fatal("expected /test target entry")
	}
	if testTarget["status"] != "up" {
		t.Errorf("expected target status=up, got %v", testTarget["status"])
	}
}

func TestHealthCheckTargetDown(t *testing.T) {
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8080, RequestTimeout: 5 * time.Second},
		Routes: []config.Route{
			{Path: "/test", Target: "http://127.0.0.1:1", Description: "unreachable"},
			{Path: "/health", Target: "", Description: "health", HealthCheck: true},
		},
	}

	log := logger.New(io.Discard)
	handler := NewHandler(cfg, log)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	targets := body["targets"].(map[string]any)
	testTarget := targets["/test"].(map[string]any)
	if testTarget["status"] != "down" {
		t.Errorf("expected target status=down, got %v", testTarget["status"])
	}
}
```

**Step 2: Run tests**

Run: `go test ./proxy/ -v`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add proxy/
git commit -m "test: add health check endpoint tests"
```

---

### Task 8: Main Entry Point — Server, Config, Graceful Shutdown

**Files:**
- Modify: `main.go` (replace placeholder)

**Step 1: Write the implementation**

```go
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bergwerk/webhook-proxy/config"
	"github.com/bergwerk/webhook-proxy/logger"
	"github.com/bergwerk/webhook-proxy/proxy"
)

func main() {
	log := logger.NewStdout()

	// Determine config file path (default: config.yaml, override with CONFIG_PATH env)
	configPath := "config.yaml"
	if p := os.Getenv("CONFIG_PATH"); p != "" {
		configPath = p
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Log(map[string]any{
			"event": "startup_error",
			"error": fmt.Sprintf("failed to load config: %v", err),
		})
		os.Exit(1)
	}

	log.Log(map[string]any{
		"event":  "startup",
		"port":   cfg.Server.Port,
		"routes": len(cfg.Routes),
	})

	handler := proxy.NewHandler(cfg, log)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Server.Port),
		Handler:      handler,
		ReadTimeout:  cfg.Server.RequestTimeout,
		WriteTimeout: cfg.Server.RequestTimeout,
	}

	// Start server in a goroutine so we can listen for shutdown signals
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Log(map[string]any{
				"event": "server_error",
				"error": err.Error(),
			})
			os.Exit(1)
		}
	}()

	// Wait for SIGINT or SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit

	log.Log(map[string]any{
		"event":  "shutdown_start",
		"signal": sig.String(),
	})

	// Graceful shutdown with 15-second timeout
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Log(map[string]any{
			"event": "shutdown_error",
			"error": err.Error(),
		})
	}

	log.Log(map[string]any{
		"event": "shutdown_complete",
	})
}
```

**Step 2: Verify it compiles**

Run: `go build -o webhook-proxy .`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add main.go
git commit -m "feat: add main entry point with server setup and graceful shutdown"
```

---

### Task 9: Dockerfile & docker-compose.yaml

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yaml`
- Create: `config.dev.yaml`

**Step 1: Create Dockerfile**

```dockerfile
# Stage 1: Build the Go binary
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o webhook-proxy .

# Stage 2: Minimal runtime image
FROM alpine:latest
RUN apk --no-cache add ca-certificates
RUN adduser -D -u 1000 appuser
WORKDIR /app
COPY --from=builder /app/webhook-proxy .
USER appuser
EXPOSE 8080
ENTRYPOINT ["./webhook-proxy"]
```

**Step 2: Create config.dev.yaml**

```yaml
server:
  port: 8080
  request_timeout: 30s

routes:
  - path: /github
    target: http://echo-server:80/webhook/github
    description: "GitHub webhooks → echo server"
    verify_signature:
      type: github
      secret_env: GITHUB_WEBHOOK_SECRET

  - path: /eas
    target: http://echo-server:80/webhook/eas
    description: "EAS webhooks → echo server"

  - path: /stripe
    target: http://echo-server:80/webhook/stripe
    description: "Stripe webhooks → echo server"
    verify_signature:
      type: stripe
      secret_env: STRIPE_WEBHOOK_SECRET

  - path: /health
    target: ""
    description: "Health check endpoint"
    health_check: true
```

**Step 3: Create docker-compose.yaml**

```yaml
version: "3.8"

services:
  webhook-proxy:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./config.dev.yaml:/app/config.yaml:ro
    environment:
      - CONFIG_PATH=/app/config.yaml
      - GITHUB_WEBHOOK_SECRET=dev-secret
      - STRIPE_WEBHOOK_SECRET=whsec_dev_secret
    depends_on:
      - echo-server

  echo-server:
    image: ealen/echo-server:latest
    ports:
      - "3000:80"
    environment:
      - PORT=80
```

**Step 4: Verify Docker build**

Run: `docker build -t webhook-proxy .`
Expected: Builds successfully

**Step 5: Commit**

```bash
git add Dockerfile docker-compose.yaml config.dev.yaml
git commit -m "feat: add Dockerfile and docker-compose for local testing"
```

---

### Task 10: End-to-End Smoke Test

**Step 1: Start docker-compose**

Run: `docker compose up -d`

**Step 2: Test webhook proxying**

Run: `curl -s -X POST http://localhost:8080/github -H "Content-Type: application/json" -d '{"action":"push"}'`
Expected: Echo server mirrors back the request

**Step 3: Test health check**

Run: `curl -s http://localhost:8080/health | python3 -m json.tool`
Expected: JSON with `status: "ok"`, targets showing echo-server as up

**Step 4: Test 404 for unknown route**

Run: `curl -s http://localhost:8080/unknown`
Expected: `{"error":"no matching route","code":404}`

**Step 5: Tear down**

Run: `docker compose down`

**Step 6: Commit any fixes discovered during smoke testing**

---

### Task 11: Create .gitignore and Final Cleanup

**Files:**
- Create: `.gitignore`

**Step 1: Create .gitignore**

```
# Binary
webhook-proxy

# IDE
.idea/
.vscode/
*.swp

# OS
.DS_Store
```

**Step 2: Run all tests one final time**

Run: `go test ./... -v`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore"
```
