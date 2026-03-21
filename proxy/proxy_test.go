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
