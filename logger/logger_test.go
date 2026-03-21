package logger

import (
	"bytes"
	"encoding/json"
	"math"
	"sync"
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

func TestLogDoesNotMutateCallerMap(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	fields := map[string]any{"event": "test"}
	log.Log(fields)

	if _, ok := fields["timestamp"]; ok {
		t.Error("Log should not mutate the caller's map")
	}
}

func TestLogFallbackOnMarshalError(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	log.Log(map[string]any{"bad": math.Inf(1)})

	var parsed map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("fallback output is not valid JSON: %v", err)
	}
	if parsed["event"] != "log_error" {
		t.Errorf("expected event=log_error, got %v", parsed["event"])
	}
}

func TestLogNilFields(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	log.Log(nil)

	var parsed map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	if _, ok := parsed["timestamp"]; !ok {
		t.Error("expected timestamp field to be present")
	}
}

func TestLogConcurrentSafety(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			log.Log(map[string]any{"n": n})
		}(i)
	}
	wg.Wait()
}
