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
