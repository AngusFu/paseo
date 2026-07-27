import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  request as httpRequest,
} from "node:http";
import net from "node:net";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface CodeServerProxyConfig {
  listenHost: string;
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  acceptLanguage?: string;
}

export interface CodeServerProxy {
  start(): Promise<void>;
  stop(): Promise<void>;
  setAcceptLanguage(value: string): void;
  getAcceptLanguage(): string;
}

function stripHopByHopHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    forwarded[key] = value;
  }
  return forwarded;
}

function buildUpstreamHeaders(
  req: IncomingMessage,
  acceptLanguage: string,
): Record<string, string | string[]> {
  const forwarded = stripHopByHopHeaders(req.headers);
  forwarded["accept-language"] = acceptLanguage;
  forwarded.host = `${forwarded.host ?? req.headers.host ?? "127.0.0.1"}`;
  return forwarded;
}

function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: CodeServerProxyConfig,
  acceptLanguage: string,
): void {
  const upstreamPath = req.url ?? "/";
  const proxyReq = httpRequest(
    {
      hostname: config.upstreamHost,
      port: config.upstreamPort,
      path: upstreamPath,
      method: req.method,
      headers: buildUpstreamHeaders(req, acceptLanguage),
    },
    (proxyRes) => {
      const responseHeaders = stripHopByHopHeaders(proxyRes.headers);
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(res, { end: true });
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("502 Bad Gateway");
    }
  });
  req.pipe(proxyReq, { end: true });
}

function proxyUpgradeRequest(
  req: IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  config: CodeServerProxyConfig,
  acceptLanguage: string,
): void {
  const targetSocket = net.connect({ host: config.upstreamHost, port: config.upstreamPort }, () => {
    const forwardedHeaders = buildUpstreamHeaders(req, acceptLanguage);
    forwardedHeaders.connection = "Upgrade";
    forwardedHeaders.upgrade = req.headers.upgrade ?? "websocket";

    const headerLines: string[] = [];
    headerLines.push(`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`);
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          headerLines.push(`${key}: ${entry}`);
        }
        continue;
      }
      headerLines.push(`${key}: ${value}`);
    }
    headerLines.push("\r\n");
    targetSocket.write(headerLines.join("\r\n"));
    if (head.length > 0) {
      targetSocket.write(head);
    }
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });
  targetSocket.on("error", () => {
    socket.end();
  });
  socket.on("error", () => {
    targetSocket.destroy();
  });
}

export function createCodeServerProxy(config: CodeServerProxyConfig): CodeServerProxy {
  let acceptLanguage = config.acceptLanguage ?? "en-US,en;q=0.9";
  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      if (server) {
        return;
      }
      server = createServer((req, res) => {
        proxyHttpRequest(req, res, config, acceptLanguage);
      });
      server.on("upgrade", (req, socket, head) => {
        proxyUpgradeRequest(req, socket as net.Socket, head, config, acceptLanguage);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(config.listenPort, config.listenHost, () => {
          server?.off("error", reject);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (!server) {
        return;
      }
      const activeServer = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    setAcceptLanguage(value: string): void {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return;
      }
      acceptLanguage = trimmed;
    },
    getAcceptLanguage(): string {
      return acceptLanguage;
    },
  };
}
