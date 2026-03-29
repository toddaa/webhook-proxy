import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * SignatureConfig holds the configuration for webhook signature verification.
 */
export interface SignatureConfig {
  type: string;
  secret_env: string;
}

/**
 * Route defines a single webhook route: an incoming path mapped to a target URL.
 */
export interface Route {
  path: string;
  target: string;
  description: string;
  health_check?: boolean;
  verify_signature?: SignatureConfig;
}

/**
 * ServerConfig holds server-level settings.
 */
export interface ServerConfig {
  port: number;
  /** Request timeout in milliseconds */
  request_timeout: number;
}

/**
 * Config is the top-level configuration structure parsed from config.yaml.
 */
export interface Config {
  server: ServerConfig;
  routes: Route[];
}

/** Supported signature verification types */
const KNOWN_VERIFIER_TYPES = new Set(["github", "stripe"]);

/**
 * Parses a duration string like "30s", "5m", "1h" into milliseconds.
 * Supports: s (seconds), m (minutes), h (hours).
 */
function parseDuration(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;

  // If it's already a number, treat as seconds
  if (typeof value === "number") return value * 1000;

  const str = String(value).trim();
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return undefined;

  const amount = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

/**
 * Load reads and parses a YAML config file, applies defaults, and validates.
 */
export function load(path: string): Config {
  const data = readFileSync(path, "utf-8");
  const raw = parseYaml(data) as Record<string, unknown>;

  const rawServer = (raw.server ?? {}) as Record<string, unknown>;
  const rawRoutes = (raw.routes ?? []) as Record<string, unknown>[];

  const config: Config = {
    server: {
      port: typeof rawServer.port === "number" ? rawServer.port : 0,
      request_timeout: parseDuration(
        rawServer.request_timeout as string | number | undefined
      ) ?? 0,
    },
    routes: rawRoutes.map((r) => ({
      path: String(r.path ?? ""),
      target: String(r.target ?? ""),
      description: String(r.description ?? ""),
      health_check: r.health_check === true,
      verify_signature: r.verify_signature
        ? {
            type: String(
              (r.verify_signature as Record<string, unknown>).type ?? ""
            ),
            secret_env: String(
              (r.verify_signature as Record<string, unknown>).secret_env ?? ""
            ),
          }
        : undefined,
    })),
  };

  applyDefaults(config);
  validate(config);

  return config;
}

/** Sets default values for any fields not specified in the config. */
function applyDefaults(config: Config): void {
  if (config.server.port === 0) {
    config.server.port = 8080;
  }
  if (config.server.request_timeout === 0) {
    config.server.request_timeout = 30_000; // 30 seconds in ms
  }
}

/** Checks the config for logical errors. Throws on validation failure. */
function validate(config: Config): void {
  if (config.routes.length === 0) {
    throw new Error("config validation: at least one route is required");
  }

  const seen = new Set<string>();
  for (const route of config.routes) {
    if (!route.path.startsWith("/")) {
      throw new Error(
        `config validation: route path must start with /: ${route.path}`
      );
    }

    if (seen.has(route.path)) {
      throw new Error(`config validation: duplicate route path: ${route.path}`);
    }
    seen.add(route.path);

    if (!route.health_check && route.target === "") {
      throw new Error(
        `config validation: route ${route.path}: target is required for non-health-check routes`
      );
    }

    if (route.verify_signature) {
      if (!KNOWN_VERIFIER_TYPES.has(route.verify_signature.type)) {
        throw new Error(
          `config validation: route ${route.path}: unknown signature verification type: ${route.verify_signature.type}`
        );
      }
      if (route.verify_signature.secret_env === "") {
        throw new Error(
          `config validation: route ${route.path}: secret_env is required when verify_signature is configured`
        );
      }
    }
  }
}
