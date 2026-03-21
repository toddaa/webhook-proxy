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
