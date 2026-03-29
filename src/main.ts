import { createServer } from "node:http";
import { load } from "./config/config.js";
import { newStdoutLogger } from "./logger/logger.js";
import { Handler } from "./proxy/proxy.js";

const logger = newStdoutLogger();

// Determine config file path (default: config.yaml, override with CONFIG_PATH env)
const configPath = process.env.CONFIG_PATH ?? "config.yaml";

let config;
try {
  config = load(configPath);
} catch (err) {
  logger.log({
    event: "startup_error",
    error: `failed to load config: ${err}`,
  });
  process.exit(1);
}

logger.log({
  event: "startup",
  port: config.server.port,
  routes: config.routes.length,
});

const handler = new Handler(config, logger);

const server = createServer((req, res) => {
  handler.handleRequest(req, res).catch((err) => {
    logger.log({
      event: "unhandled_request_error",
      error: String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error", code: 500 }));
    }
  });
});

// Set server timeouts from config
server.timeout = config.server.request_timeout;
server.keepAliveTimeout = config.server.request_timeout;

server.listen(config.server.port, () => {
  logger.log({
    event: "server_listening",
    port: config.server.port,
  });
});

// Graceful shutdown on SIGINT or SIGTERM
function shutdown(signal: string): void {
  logger.log({
    event: "shutdown_start",
    signal,
  });

  // Give existing connections 15 seconds to finish
  const forceTimeout = setTimeout(() => {
    logger.log({
      event: "shutdown_timeout",
    });
    process.exit(1);
  }, 15_000);

  // Don't let the timeout keep the process alive if server closes in time
  forceTimeout.unref();

  server.close(() => {
    handler.close();
    clearTimeout(forceTimeout);
    logger.log({
      event: "shutdown_complete",
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
