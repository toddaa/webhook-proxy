import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { Logger } from "./logger.js";

/** Helper: creates a logger backed by a buffer, returns [logger, getOutput]. */
function createTestLogger(): [Logger, () => string] {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  const logger = new Logger(stream);
  const getOutput = () => Buffer.concat(chunks).toString("utf-8");
  return [logger, getOutput];
}

describe("logger", () => {
  it("outputs valid JSON", () => {
    const [logger, getOutput] = createTestLogger();
    logger.log({ event: "test", message: "hello" });

    const parsed = JSON.parse(getOutput());
    expect(parsed.event).toBe("test");
    expect(parsed.message).toBe("hello");
    expect(parsed.timestamp).toBeDefined();
  });

  it("adds a timestamp field automatically", () => {
    const [logger, getOutput] = createTestLogger();
    logger.log({ event: "test" });

    const parsed = JSON.parse(getOutput());
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp.length).toBeGreaterThan(0);
  });

  it("does not mutate the caller's fields object", () => {
    const [logger] = createTestLogger();
    const fields: Record<string, unknown> = { event: "test" };
    logger.log(fields);

    expect(fields).not.toHaveProperty("timestamp");
  });

  it("handles null fields gracefully", () => {
    const [logger, getOutput] = createTestLogger();
    logger.log(null);

    const parsed = JSON.parse(getOutput());
    expect(parsed.timestamp).toBeDefined();
  });

  it("handles circular reference with fallback", () => {
    const [logger, getOutput] = createTestLogger();
    const circular: Record<string, unknown> = { event: "test" };
    circular.self = circular;
    logger.log(circular);

    const parsed = JSON.parse(getOutput());
    expect(parsed.event).toBe("log_error");
  });
});
