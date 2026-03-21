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

// routeEntry holds a parsed route with its reverse proxy and optional verifier.
type routeEntry struct {
	route    config.Route
	proxy    *httputil.ReverseProxy
	verifier verify.SignatureVerifier
}

// Handler implements http.Handler and routes incoming webhook requests.
type Handler struct {
	entries   []routeEntry
	config    *config.Config
	logger    *logger.Logger
	startTime time.Time
}

// NewHandler creates a Handler from the given config and logger.
func NewHandler(cfg *config.Config, log *logger.Logger) *Handler {
	h := &Handler{
		config:    cfg,
		logger:    log,
		startTime: time.Now(),
	}

	for _, route := range cfg.Routes {
		entry := routeEntry{route: route}

		if route.HealthCheck {
			h.entries = append(h.entries, entry)
			continue
		}

		target, err := url.Parse(route.Target)
		if err != nil {
			log.Log(map[string]any{
				"event": "route_parse_error",
				"path":  route.Path,
				"error": err.Error(),
			})
			continue
		}

		rp := &httputil.ReverseProxy{
			Director:     makeDirector(target, route.Path),
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				writeJSONError(w, fmt.Sprintf("upstream error: %s", err.Error()), http.StatusBadGateway)
			},
		}
		entry.proxy = rp

		if route.VerifySignature != nil {
			secret := os.Getenv(route.VerifySignature.SecretEnv)
			if secret != "" {
				v, err := verify.New(route.VerifySignature.Type, secret)
				if err != nil {
					log.Log(map[string]any{
						"event": "verifier_create_error",
						"path":  route.Path,
						"error": err.Error(),
					})
				} else {
					entry.verifier = v
				}
			}
		}

		h.entries = append(h.entries, entry)
	}

	return h
}

// ServeHTTP routes the request to the matching backend or returns an error.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	for _, entry := range h.entries {
		if !matchRoute(r.URL.Path, entry.route.Path) {
			continue
		}

		// Health check route
		if entry.route.HealthCheck {
			h.handleHealthCheck(w, r)
			h.logRequest(r, entry.route.Path, http.StatusOK, time.Since(start), nil)
			return
		}

		// Read body for potential signature verification
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSONError(w, "failed to read request body", http.StatusInternalServerError)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

		// Signature verification (informational only, always proxy)
		var sigResult *bool
		if entry.verifier != nil {
			valid, verifyErr := entry.verifier.Verify(bodyBytes, r.Header)
			if verifyErr != nil {
				h.logger.Log(map[string]any{
					"event":           "signature_verification_error",
					"path":            r.URL.Path,
					"route":           entry.route.Path,
					"error":           verifyErr.Error(),
				})
				v := false
				sigResult = &v
			} else {
				sigResult = &valid
				h.logger.Log(map[string]any{
					"event":           "signature_verification",
					"path":            r.URL.Path,
					"route":           entry.route.Path,
					"signature_valid": valid,
				})
			}
		}

		entry.proxy.ServeHTTP(w, r)
		h.logRequest(r, entry.route.Path, 0, time.Since(start), sigResult)
		return
	}

	writeJSONError(w, "no matching route", http.StatusNotFound)
	h.logRequest(r, "", http.StatusNotFound, time.Since(start), nil)
}

// matchRoute returns true if reqPath matches routePath exactly or as a prefix.
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

// handleHealthCheck responds with a JSON health status including target checks.
func (h *Handler) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	client := &http.Client{Timeout: 5 * time.Second}

	type targetStatus struct {
		Status         string  `json:"status"`
		ResponseTimeMs *int64  `json:"response_time_ms,omitempty"`
		Error          string  `json:"error,omitempty"`
	}

	targets := make(map[string]targetStatus)
	routeCount := 0

	for _, entry := range h.entries {
		if entry.route.HealthCheck {
			continue
		}
		routeCount++

		start := time.Now()
		resp, err := client.Get(entry.route.Target)
		elapsed := time.Since(start).Milliseconds()

		if err != nil {
			targets[entry.route.Path] = targetStatus{
				Status: "down",
				Error:  err.Error(),
			}
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			targets[entry.route.Path] = targetStatus{
				Status:         "up",
				ResponseTimeMs: &elapsed,
			}
		} else {
			targets[entry.route.Path] = targetStatus{
				Status: "down",
				Error:  fmt.Sprintf("HTTP %d", resp.StatusCode),
			}
		}
	}

	uptime := time.Since(h.startTime).String()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"status":  "ok",
		"routes":  routeCount,
		"uptime":  uptime,
		"targets": targets,
	})
}

// writeJSONError writes a JSON error response.
func writeJSONError(w http.ResponseWriter, message string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{
		"error": message,
		"code":  code,
	})
}

// logRequest logs request details via the structured logger.
func (h *Handler) logRequest(r *http.Request, route string, status int, duration time.Duration, sigResult *bool) {
	fields := map[string]any{
		"event":       "request",
		"method":      r.Method,
		"path":        r.URL.Path,
		"duration_ms": duration.Milliseconds(),
	}
	if route != "" {
		fields["route"] = route
	}
	if status != 0 {
		fields["status"] = status
	}
	if sigResult != nil {
		fields["signature_valid"] = *sigResult
	}
	h.logger.Log(fields)
}
