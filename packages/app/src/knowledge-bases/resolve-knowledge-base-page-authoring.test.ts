import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client";
import {
  resolveKnowledgeBaseDeletePage,
  resolveKnowledgeBasePageAuthoringApis,
  resolveKnowledgeBaseUpsertPage,
} from "./resolve-knowledge-base-page-authoring";

describe("resolveKnowledgeBasePageAuthoringApis", () => {
  it("returns null methods when client is missing", () => {
    expect(resolveKnowledgeBasePageAuthoringApis(null)).toEqual({
      upsertPage: null,
      deletePage: null,
      ready: false,
    });
  });

  it("returns null when methods are absent on the client", () => {
    const client = {} as DaemonClient;
    expect(resolveKnowledgeBaseUpsertPage(client)).toBeNull();
    expect(resolveKnowledgeBaseDeletePage(client)).toBeNull();
    expect(resolveKnowledgeBasePageAuthoringApis(client).ready).toBe(false);
  });

  it("binds present upsert and delete methods", async () => {
    const upsertPage = vi.fn(async () => ({
      requestId: "r1",
      path: "index.md",
      error: null,
    }));
    const deletePage = vi.fn(async () => ({
      requestId: "r2",
      path: "index.md",
      error: null,
    }));
    const client = {
      knowledgeBaseUpsertPage: upsertPage,
      knowledgeBaseDeletePage: deletePage,
    } as unknown as DaemonClient;

    const apis = resolveKnowledgeBasePageAuthoringApis(client);
    expect(apis.ready).toBe(true);
    expect(apis.upsertPage).not.toBeNull();
    expect(apis.deletePage).not.toBeNull();

    await apis.upsertPage?.({
      idOrSlug: "runbooks",
      path: "index.md",
      content: "# hi\n",
    });
    await apis.deletePage?.({ idOrSlug: "runbooks", path: "index.md" });

    expect(upsertPage).toHaveBeenCalledWith({
      idOrSlug: "runbooks",
      path: "index.md",
      content: "# hi\n",
    });
    expect(deletePage).toHaveBeenCalledWith({
      idOrSlug: "runbooks",
      path: "index.md",
    });
  });
});
