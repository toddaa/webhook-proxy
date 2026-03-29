import { describe, it, expect, afterEach } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { Config } from "../config/config.js";
import { Logger } from "../logger/logger.js";
import { PassThrough } from "node:stream";
import { Handler } from "./proxy.js";

/** Creates a devnull logger for tests. */
function devnullLogger(): Logger {
  const stream = new PassThrough();
  stream.resume(); // drain so it doesn't back up
  return new Logger(stream);
}

/** Creates a backend HTTP server and returns it with its URL. */
function createBackend(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

/** Makes an HTTP request and returns the response. */
function makeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const http = require("node:http");
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: options.method ?? "POST",
        headers: options.headers ?? {},
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers[key] = value;
          }
          resolve({ status: res.statusCode ?? 0, body, headers });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers) {
    s.close();
  }
  servers.length = 0;
});

describe("proxy handler", () => {
  it("matches a route by exact path", async () => {
    const { server: backend, url: backendUrl } = await createBackend(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`path=${req.url}`);
      }
    );
    servers.push(backend);

    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/github",
          target: `${backendUrl}/webhook/github`,
          description: "test",
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const response = await makeRequest(
      `http://127.0.0.1:${port}/github`,
      { body: '{"test":true}' }
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("path=/webhook/github");
  });

  it("matches a route with extra path segments", async () => {
    const { server: backend, url: backendUrl } = await createBackend(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`path=${req.url}`);
      }
    );
    servers.push(backend);

    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/github",
          target: `${backendUrl}/webhook/github`,
          description: "test",
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const response = await makeRequest(
      `http://127.0.0.1:${port}/github/push`,
      { body: "{}" }
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("path=/webhook/github/push");
  });

  it("returns 404 for unmatched routes", async () => {
    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/github",
          target: "http://localhost:9999",
          description: "test",
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const response = await makeRequest(
      `http://127.0.0.1:${port}/unknown`,
      { body: "{}" }
    );

    expect(response.status).toBe(404);
  });

  it("adds proxy headers to upstream requests", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const { server: backend, url: backendUrl } = await createBackend(
      (req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200);
        res.end();
      }
    );
    servers.push(backend);

    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/test",
          target: backendUrl,
          description: "test",
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    await makeRequest(`http://127.0.0.1:${port}/test`, {
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "custom-value",
      },
      body: "{}",
    });

    expect(receivedHeaders["content-type"]).toBe("application/json");
    expect(receivedHeaders["x-custom-header"]).toBe("custom-value");
    expect(receivedHeaders["x-webhook-proxy-route"]).toBe("/test");
    expect(receivedHeaders["x-webhook-proxy-timestamp"]).toBeDefined();
  });

  it("preserves request body through the proxy", async () => {
    let receivedBody = "";
    const { server: backend, url: backendUrl } = await createBackend(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200);
          res.end();
        });
      }
    );
    servers.push(backend);

    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/test",
          target: backendUrl,
          description: "test",
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const body = '{"event":"push","ref":"refs/heads/main"}';
    await makeRequest(`http://127.0.0.1:${port}/test`, { body });

    expect(receivedBody).toBe(body);
  });

  it("returns health check JSON response", async () => {
    const { server: backend, url: backendUrl } = await createBackend(
      (_req, res) => {
        res.writeHead(200);
        res.end();
      }
    );
    servers.push(backend);

    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/test",
          target: backendUrl,
          description: "test backend",
        },
        {
          path: "/health",
          target: "",
          description: "health",
          health_check: true,
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const response = await makeRequest(
      `http://127.0.0.1:${port}/health`,
      { method: "GET" }
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.routes).toBe(1);
    expect(body.targets["/test"].status).toBe("up");
  });

  it("reports down targets in health check", async () => {
    const cfg: Config = {
      server: { port: 0, request_timeout: 5000 },
      routes: [
        {
          path: "/test",
          target: "http://127.0.0.1:1",
          description: "unreachable",
        },
        {
          path: "/health",
          target: "",
          description: "health",
          health_check: true,
        },
      ],
    };

    const handler = new Handler(cfg, devnullLogger());
    const proxyServer = createServer((req, res) => {
      handler.handleRequest(req, res);
    });
    proxyServer.listen(0, "127.0.0.1");
    servers.push(proxyServer);

    await new Promise<void>((r) => proxyServer.on("listening", r));
    const addr = proxyServer.address();
    const port = typeof addr === "object" ? addr!.port : 0;

    const response = await makeRequest(
      `http://127.0.0.1:${port}/health`,
      { method: "GET" }
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.targets["/test"].status).toBe("down");
  });
});
