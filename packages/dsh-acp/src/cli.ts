#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stdin, stdout } from "node:process";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { DshAcpAgent } from "./agent.js";
import { parseCliFlags, parseDshAcpConfig } from "./config.js";
import { DshCliRuntime } from "./runtime.js";
import { setupDshToolchain } from "./toolchain.js";

const HELP = `dsh-acp - ACP adapter for DeepSeek Harness

Usage:
  dsh-acp [options]
  dsh-acp setup [options]

Options:
  --provider <route>       DSH model provider route
  --model <model>          DSH model name
  --runtime-bin <path>     dsh-jsonrpc-agent executable
  --cordis <path>          Base Cordis configuration
  --dsh-home <path>        DSH home directory
  --session-root <path>    DSH session storage directory
  --max-tokens <number>    Maximum model output tokens
  -h, --help               Show help
  -v, --version            Show version
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "setup") {
    await runSetup(argv.slice(1));
    return;
  }
  const flags = parseCliFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(readFileSync(require.resolve("../package.json"), "utf8")) as {
      version: string;
    };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const config = parseDshAcpConfig(argv, process.env);
  const stream = ndJsonStream(toWritableStream(stdout), toReadableStream(stdin));
  let adapter: DshAcpAgent | undefined;
  const connection = new AgentSideConnection((sink) => {
    adapter = new DshAcpAgent({ connection: sink, config, runtime: new DshCliRuntime() });
    return adapter;
  }, stream);
  await connection.closed;
  await adapter?.close();
}

async function runSetup(argv: string[]): Promise<void> {
  const flags = parseCliFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = parseDshAcpConfig(argv, process.env);
  const toolchain = await setupDshToolchain({ dshHome: config.dshHome });
  process.stdout.write(
    `${JSON.stringify({ runtimeBin: toolchain.runtimeBin, cordis: toolchain.cordisPath }, null, 2)}\n`,
  );
}

function toReadableStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      input.on("end", () => controller.close());
      input.on("error", (error) => controller.error(error));
    },
  });
}

function toWritableStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        output.write(chunk, (error?: Error | null) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dsh-acp: ${message}\n`);
  process.exitCode = 1;
});
