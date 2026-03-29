import type { Writable } from "node:stream";

/**
 * Logger writes structured JSON log entries to a writable stream.
 * Each call to log() produces one JSON object per line.
 */
export class Logger {
  private writer: Writable;

  constructor(writer: Writable) {
    this.writer = writer;
  }

  /**
   * Writes a single JSON log entry. Automatically adds a "timestamp"
   * field with the current time in ISO 8601 (RFC 3339) format.
   */
  log(fields: Record<string, unknown> | null): void {
    const entry: Record<string, unknown> = {
      ...(fields ?? {}),
      timestamp: new Date().toISOString(),
    };

    try {
      const data = JSON.stringify(entry);
      this.writer.write(data + "\n");
    } catch {
      // Fallback: log the serialization error itself
      const fallback = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "log_error",
        error: "failed to serialize log entry",
      });
      this.writer.write(fallback + "\n");
    }
  }
}

/** Creates a Logger that writes to process.stdout. */
export function newStdoutLogger(): Logger {
  return new Logger(process.stdout);
}
