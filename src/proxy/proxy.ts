import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import httpProxy from "http-proxy";
import type { Config, Route } from "../config/config.js";
import type { Logger } from "../logger/logger.js";
import { createVerifier, type SignatureVerifier } from "../verify/index.js";

/** Maximum body size for signature verification (10 MB) */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * RouteEntry holds a parsed route with its reverse proxy and optional verifier.
 */
interface RouteEntry {
  route: Route;
  proxy: httpProxy | null;
  verifier: SignatureVerifier | null;
}

/**
 * Handler routes incoming webhook requests to configured backends.
 */
export class Handler {
  private entries: RouteEntry[] = [];
  private config: Config;
  private logger: Logger;
  private startTime: Date;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.startTime = new Date();

    for (const route of config.routes) {
      const entry: RouteEntry = {
        route,
        proxy: null,
        verifier: null,
      };

      if (route.health_check) {
        this.entries.push(entry);
        continue;
      }

      // Validate the target URL can be parsed
      try {
        new URL(route.target);
      } catch (err) {
        logger.log({
          event: "route_parse_error",
          path: route.path,
          error: String(err),
        });
        continue;
      }

      // Create a reverse proxy instance for this route
      const proxyServer = httpProxy.createProxyServer({
        // Target will be set per-request in the handler
        changeOrigin: true,
        // Don't auto-rewrite the path — we handle path rewriting ourselves
      });

      // Handle proxy errors by returning a JSON error response
      proxyServer.on("error", (err, _req, res) => {
        if (res && "writeHead" in res) {
          writeJSONError(
            res as ServerResponse,
            `upstream error: ${err.message}`,
            502
          );
        }
      });

      entry.proxy = proxyServer;

      // Set up signature verification if configured
      if (route.verify_signature) {
        const secret = process.env[route.verify_signature.secret_env] ?? "";
        if (secret !== "") {
          try {
            entry.verifier = createVerifier(
              route.verify_signature.type,
              secret
            );
          } catch (err) {
            logger.log({
              event: "verifier_create_error",
              path: route.path,
              error: String(err),
            });
          }
        }
      }

      this.entries.push(entry);
    }
  }

  /**
   * handleRequest routes the request to the matching backend or returns an error.
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const start = Date.now();
    const reqPath = req.url ?? "/";

    for (const entry of this.entries) {
      if (!matchRoute(reqPath, entry.route.path)) {
        continue;
      }

      // Health check route
      if (entry.route.health_check) {
        await this.handleHealthCheck(req, res);
        this.logRequest(req, entry.route.path, 200, Date.now() - start, null);
        return;
      }

      // Signature verification (informational only — always proxy regardless)
      let sigResult: boolean | null = null;
      if (entry.verifier) {
        try {
          const bodyBytes = await readBody(req, MAX_BODY_SIZE);
          const { valid, error: verifyErr } = entry.verifier.verify(
            bodyBytes,
            req.headers
          );

          if (verifyErr) {
            this.logger.log({
              event: "signature_verification_error",
              path: reqPath,
              route: entry.route.path,
              error: verifyErr,
            });
            sigResult = false;
          } else {
            sigResult = valid;
            this.logger.log({
              event: "signature_verification",
              path: reqPath,
              route: entry.route.path,
              signature_valid: valid,
            });
          }

          // Restore body for proxying by replacing the request stream
          // We need to override the internal data so http-proxy can re-read it
          (req as IncomingMessage & { body?: Buffer }).body = bodyBytes;
          // Push the body back into the request stream
          req.push(bodyBytes);
          req.push(null);
        } catch {
          writeJSONError(res, "failed to read request body", 500);
          return;
        }
      }

      // Compute the rewritten path: strip the route prefix, append to target path
      const targetUrl = new URL(entry.route.target);
      const extra = reqPath.slice(entry.route.path.length);
      const rewrittenPath = targetUrl.pathname + extra;

      // Add proxy headers
      req.headers["x-webhook-proxy-route"] = entry.route.path;
      req.headers["x-webhook-proxy-timestamp"] = new Date().toISOString();

      // Set the rewritten URL on the request BEFORE proxying so http-proxy uses it
      req.url = rewrittenPath + (targetUrl.search ?? "");

      // Proxy the request
      const status = await new Promise<number>((resolve) => {
        // Intercept writeHead to capture the status code
        const origWriteHead = res.writeHead.bind(res);
        let capturedStatus = 200;
        res.writeHead = function (
          statusCode: number,
          ...args: unknown[]
        ): ServerResponse {
          capturedStatus = statusCode;
          return (origWriteHead as Function)(statusCode, ...args);
        };

        entry.proxy!.web(
          req,
          res,
          {
            target: `${targetUrl.protocol}//${targetUrl.host}`,
            // ignorePath: we already set req.url to the rewritten path
            ignorePath: false,
            prependPath: false,
          },
          (err) => {
            if (err) {
              resolve(502);
            }
          }
        );

        res.on("finish", () => {
          resolve(capturedStatus);
        });
      });

      this.logRequest(req, entry.route.path, status, Date.now() - start, sigResult);
      return;
    }

    // No matching route found
    writeJSONError(res, "no matching route", 404);
    this.logRequest(req, "", 404, Date.now() - start, null);
  }

  /**
   * Responds with a JSON health status including concurrent target probing.
   */
  private async handleHealthCheck(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Collect non-health-check entries to probe
    const probeEntries = this.entries.filter(
      (e) => !e.route.health_check
    );

    // Probe all targets concurrently
    const results: Record<
      string,
      { status: string; response_time_ms?: number; error?: string }
    > = {};

    await Promise.all(
      probeEntries.map(async (entry) => {
        const start = Date.now();
        try {
          const targetUrl = new URL(entry.route.target);
          const statusCode = await probeTarget(targetUrl, 5000);
          const elapsed = Date.now() - start;

          if (statusCode >= 200 && statusCode < 300) {
            results[entry.route.path] = {
              status: "up",
              response_time_ms: elapsed,
            };
          } else {
            results[entry.route.path] = {
              status: "down",
              error: `HTTP ${statusCode}`,
            };
          }
        } catch (err) {
          results[entry.route.path] = {
            status: "down",
            error: String(err),
          };
        }
      })
    );

    const uptime = formatUptime(Date.now() - this.startTime.getTime());

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        routes: probeEntries.length,
        uptime,
        targets: results,
      })
    );
  }

  /** Logs request details via the structured logger. */
  private logRequest(
    req: IncomingMessage,
    route: string,
    status: number,
    durationMs: number,
    sigResult: boolean | null
  ): void {
    const fields: Record<string, unknown> = {
      event: "request",
      method: req.method,
      path: req.url,
      duration_ms: durationMs,
    };
    if (route !== "") {
      fields.route = route;
    }
    if (status !== 0) {
      fields.status = status;
    }
    if (sigResult !== null) {
      fields.signature_valid = sigResult;
    }
    this.logger.log(fields);
  }

  /** Closes all proxy servers. */
  close(): void {
    for (const entry of this.entries) {
      entry.proxy?.close();
    }
  }
}

/**
 * Returns true if reqPath matches routePath exactly or as a prefix with '/'.
 */
function matchRoute(reqPath: string, routePath: string): boolean {
  if (reqPath === routePath) return true;
  return reqPath.startsWith(routePath + "/");
}

/** Reads the request body up to maxBytes into a Buffer. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

/** Sends a JSON error response. */
function writeJSONError(
  res: ServerResponse,
  message: string,
  code: number
): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message, code }));
}

/**
 * Probes a target URL with a GET request and returns the HTTP status code.
 * Times out after the given number of milliseconds.
 */
function probeTarget(targetUrl: URL, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const protocol = targetUrl.protocol === "https:" ? require("node:https") : require("node:http");
    const req = protocol.get(
      targetUrl.href,
      { timeout: timeoutMs },
      (res: IncomingMessage) => {
        // Consume the response body so the socket can be freed
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", (err: Error) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * Formats a duration in milliseconds to a human-readable string like Go's
 * time.Duration.String() — e.g. "2h30m15.123s" or "45.678s".
 */
function formatUptime(ms: number): string {
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let result = "";
  if (hours > 0) result += `${hours}h`;
  if (minutes > 0) result += `${minutes}m`;
  // Always show seconds with up to 3 decimal places, trimming trailing zeros
  const secStr = seconds.toFixed(3).replace(/\.?0+$/, "");
  result += `${secStr}s`;

  return result;
}
