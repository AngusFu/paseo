import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeServerProxy } from "./code-server-proxy.js";

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("probe did not bind a TCP port"));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function listen(
  handler: (req: IncomingMessage) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    handler(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("upstream server did not bind a TCP port");
  }
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("code-server proxy", () => {
  const proxies: Array<{ stop: () => Promise<void> }> = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it("rewrites Accept-Language when forwarding HTTP requests", async () => {
    let capturedAcceptLanguage: string | undefined;
    const upstream = await listen((req) => {
      capturedAcceptLanguage = req.headers["accept-language"];
    });
    servers.push(upstream.server);

    const proxyPort = await reservePort();
    const proxy = createCodeServerProxy({
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstream.port,
      acceptLanguage: "zh-CN,zh;q=0.9",
    });
    proxies.push(proxy);
    await proxy.start();

    const response = await fetch(`http://127.0.0.1:${proxyPort}/`, {
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    expect(response.status).toBe(200);
    expect(capturedAcceptLanguage).toBe("zh-CN,zh;q=0.9");
  });

  it("updates Accept-Language after setAcceptLanguage", async () => {
    let capturedAcceptLanguage: string | undefined;
    const upstream = await listen((req) => {
      capturedAcceptLanguage = req.headers["accept-language"];
    });
    servers.push(upstream.server);

    const proxyPort = await reservePort();
    const proxy = createCodeServerProxy({
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstream.port,
      acceptLanguage: "en-US,en;q=0.9",
    });
    proxies.push(proxy);
    await proxy.start();
    proxy.setAcceptLanguage("ja,ja-JP;q=0.9");

    const response = await fetch(`http://127.0.0.1:${proxyPort}/`);
    expect(response.status).toBe(200);
    expect(capturedAcceptLanguage).toBe("ja,ja-JP;q=0.9");
  });
});
