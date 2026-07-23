import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlamaService } from "./llama-service.js";

const MODEL_FILENAME = "test-model.gguf";
const GGUF_MAGIC = Buffer.from([0x47, 0x47, 0x55, 0x46]);

describe("LlamaService.getStatus", () => {
  let paseoHome: string;
  let service: LlamaService;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "llama-service-status-"));
    await mkdir(join(paseoHome, "models"), { recursive: true });
    service = new LlamaService({
      paseoHome,
      logger: pino({ level: "silent" }),
      // A URL nothing is listening on, so startDownload fails fast.
      getModelConfig: () => ({
        modelFilename: MODEL_FILENAME,
        modelUrls: ["http://127.0.0.1:9/missing.gguf"],
      }),
    });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function writeModel(contents: Buffer): Promise<void> {
    await writeFile(join(paseoHome, "models", MODEL_FILENAME), contents);
  }

  it("reports absent when no model file exists", async () => {
    await expect(service.getStatus()).resolves.toEqual({ status: "absent" });
  });

  it("reports ready for a file with the GGUF magic", async () => {
    await writeModel(Buffer.concat([GGUF_MAGIC, Buffer.alloc(16)]));

    await expect(service.getStatus()).resolves.toMatchObject({ status: "ready" });
  });

  it("reports a model that appeared without this process downloading it", async () => {
    // Copied in by hand, restored from a backup, or left by an earlier run:
    // status has to come from the disk, not from what this process did.
    await expect(service.getStatus()).resolves.toEqual({ status: "absent" });
    await writeModel(Buffer.concat([GGUF_MAGIC, Buffer.alloc(16)]));

    await expect(service.getStatus()).resolves.toMatchObject({ status: "ready" });
  });

  it("stops reporting a past download failure once a usable model is present", async () => {
    // A download that failed while offline used to latch: the remembered error
    // outranked the file check, so a model obtained any other way stayed
    // invisible until the daemon restarted.
    await service.startDownload();
    await expect.poll(async () => (await service.getStatus()).status).toBe("error");

    await writeModel(Buffer.concat([GGUF_MAGIC, Buffer.alloc(16)]));

    await expect(service.getStatus()).resolves.toMatchObject({ status: "ready" });
  });

  it("reports a corrupt file rather than claiming the model is ready", async () => {
    await writeModel(Buffer.from("not a gguf file"));

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("corrupt"),
    });
  });
  it("uses a model already on disk under a different name", async () => {
    // The configured filename moves on (a new default ships, the user picks
    // another build) while a perfectly good model stays in the directory.
    await writeFile(
      join(paseoHome, "models", "some-other-model.gguf"),
      Buffer.concat([GGUF_MAGIC, Buffer.alloc(16)]),
    );

    await expect(service.getStatus()).resolves.toMatchObject({ status: "ready" });
  });

  it("ignores mmproj companions, which cannot answer on their own", async () => {
    await writeFile(
      join(paseoHome, "models", "gemma-mmproj.gguf"),
      Buffer.concat([GGUF_MAGIC, Buffer.alloc(16)]),
    );

    await expect(service.getStatus()).resolves.toEqual({ status: "absent" });
  });
});
