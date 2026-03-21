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
// field with the current time in RFC3339 format.
func (l *Logger) Log(fields map[string]any) {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Copy fields to avoid mutating the caller's map
	entry := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		entry[k] = v
	}
	entry["timestamp"] = time.Now().UTC().Format(time.RFC3339)

	data, err := json.Marshal(entry)
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
