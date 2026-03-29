import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "./config.js";

/** Helper: writes YAML content to a temp file and returns its path. */
function writeTempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "webhook-proxy-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("config", () => {
  it("loads a valid config with explicit values", () => {
    const path = writeTempConfig(`
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
`);

    const cfg = load(path);
    expect(cfg.server.port).toBe(9090);
    expect(cfg.server.request_timeout).toBe(15_000); // 15s in ms
    expect(cfg.routes).toHaveLength(2);
    expect(cfg.routes[0].path).toBe("/github");
  });

  it("applies default values when not specified", () => {
    const path = writeTempConfig(`
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
`);

    const cfg = load(path);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.request_timeout).toBe(30_000); // 30s default
  });

  it("rejects duplicate route paths", () => {
    const path = writeTempConfig(`
routes:
  - path: /test
    target: http://localhost:8080
    description: "test1"
  - path: /test
    target: http://localhost:8081
    description: "test2"
`);

    expect(() => load(path)).toThrow("duplicate route path");
  });

  it("rejects routes with missing target (non-health-check)", () => {
    const path = writeTempConfig(`
routes:
  - path: /test
    target: ""
    description: "missing target"
`);

    expect(() => load(path)).toThrow("target is required");
  });

  it("rejects unknown verifier types", () => {
    const path = writeTempConfig(`
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
    verify_signature:
      type: unknown_provider
      secret_env: SECRET
`);

    expect(() => load(path)).toThrow("unknown signature verification type");
  });

  it("allows empty target for health check routes", () => {
    const path = writeTempConfig(`
routes:
  - path: /health
    target: ""
    description: "health"
    health_check: true
`);

    expect(() => load(path)).not.toThrow();
  });

  it("rejects empty routes array", () => {
    const path = writeTempConfig(`
server:
  port: 8080
routes: []
`);

    expect(() => load(path)).toThrow("at least one route is required");
  });

  it("rejects paths without leading slash", () => {
    const path = writeTempConfig(`
routes:
  - path: github
    target: http://localhost:8080
    description: "missing slash"
`);

    expect(() => load(path)).toThrow("route path must start with /");
  });

  it("rejects missing secret_env when verify_signature is set", () => {
    const path = writeTempConfig(`
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
    verify_signature:
      type: github
      secret_env: ""
`);

    expect(() => load(path)).toThrow("secret_env is required");
  });
});
