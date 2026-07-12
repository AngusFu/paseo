import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanSecretsStore } from "./secrets-store.js";
import { KanbanCardDetailService } from "./detail.js";
import { credentialRefForConnection } from "./oauth.js";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

function jiraIssueWithAttachmentBody() {
  return {
    key: "PROJ-1",
    fields: {
      summary: "Fix the thing",
      attachment: [
        {
          id: "10001",
          filename: "screenshot.png",
          mimeType: "image/png",
          content: "https://jira.example.com/secure/attachment/10001/screenshot.png",
        },
      ],
    },
  };
}

function fetchAttachmentBytes(init: RequestInit | undefined) {
  const headers = init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe(
    `Basic ${Buffer.from("dev@example.com:secret-token").toString("base64")}`,
  );
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "image/png" }),
  } as unknown as Response;
}

async function seedJiraCardWithAttachment(options: {
  store: KanbanStore;
  secrets: KanbanSecretsStore;
}) {
  const { store: kanbanStore, secrets: kanbanSecrets } = options;
  await kanbanStore.createConnection({
    kind: "jira",
    name: "Jira Cloud",
    baseUrl: "https://jira.example.com",
    email: "dev@example.com",
  });
  const connection = (await kanbanStore.listConnections())[0];
  await kanbanSecrets.set(credentialRefForConnection(connection.id), {
    method: "token",
    token: "secret-token",
  });
  await kanbanStore.setConnectionAuthConnected(connection.id, true);
  await kanbanStore.createSource({
    kind: "jira",
    name: "Jira Cloud",
    connectionId: connection.id,
    query: "project = PROJ",
  });
  return kanbanStore.upsertCardBySource(
    { kind: "jira", externalId: "jira:PROJ-1", project: "PROJ", issueKey: "PROJ-1" },
    {
      title: "Fix the thing",
      url: "https://jira.example.com/browse/PROJ-1",
      status: "wip",
      columnId: (await kanbanStore.listColumns())[0].id,
      theme: "jira",
    },
  );
}

describe("KanbanCardDetailService", () => {
  let tempDir: string;
  let store: KanbanStore;
  let secrets: KanbanSecretsStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kanban-detail-test-"));
    store = new KanbanStore(tempDir);
    secrets = new KanbanSecretsStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns an error when the card doesn't exist", async () => {
    const service = new KanbanCardDetailService({
      store,
      secrets,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const result = await service.getDetail("kbc_missing");
    expect(result.detail).toBeNull();
    expect(result.error).toBe("Kanban card not found: kbc_missing");
  });

  test("returns basic fields for a manual card without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const service = new KanbanCardDetailService({
      store,
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const card = await store.createCard({ title: "Buy milk", url: "https://example.com/todo" });

    const result = await service.getDetail(card.id);
    expect(result.error).toBeNull();
    expect(result.detail).toMatchObject({
      title: "Buy milk",
      url: "https://example.com/todo",
      externalStatus: null,
      descriptionMarkdown: null,
      commentCount: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("getComments returns an empty list for a manual card without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const service = new KanbanCardDetailService({
      store,
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const card = await store.createCard({ title: "Buy milk", url: "https://example.com/todo" });

    const result = await service.getComments(card.id);
    expect(result.error).toBeNull();
    expect(result.comments).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fetches and normalizes a Jira Cloud issue, with commentCount and a resolved attachment image", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://jira.example.com",
      email: "dev@example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "secret-token",
    });
    await store.setConnectionAuthConnected(connection.id, true);
    await store.createSource({
      kind: "jira",
      name: "Jira Cloud",
      connectionId: connection.id,
      query: "project = PROJ",
    });
    const card = await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-1", project: "PROJ", issueKey: "PROJ-1" },
      {
        title: "Fix the thing",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "jira",
      },
    );

    const adfDescription = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Steps to reproduce" }] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "screenshot.png" } }] },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/comment?maxResults=0")) {
        return jsonResponse(200, { total: 3, comments: [] });
      }
      return jsonResponse(200, {
        key: "PROJ-1",
        fields: {
          summary: "Fix the thing",
          description: adfDescription,
          status: { name: "In Code Review" },
          assignee: { displayName: "Ada Lovelace" },
          reporter: { displayName: "Grace Hopper" },
          labels: ["bug"],
          priority: { name: "High" },
          created: "2024-01-01T00:00:00.000Z",
          updated: "2024-01-03T00:00:00.000Z",
          attachment: [
            {
              id: "10001",
              filename: "screenshot.png",
              mimeType: "image/png",
              content: "https://jira.example.com/secure/attachment/10001/screenshot.png",
            },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getDetail(card.id);

    expect(result.error).toBeNull();
    expect(result.detail).toMatchObject({
      title: "Fix the thing",
      url: "https://jira.example.com/browse/PROJ-1",
      externalStatus: "In Code Review",
      assignee: "Ada Lovelace",
      reporter: "Grace Hopper",
      labels: ["bug"],
      priority: "High",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-03T00:00:00.000Z",
      commentCount: 3,
    });
    expect(result.detail?.attachments).toEqual([
      {
        filename: "screenshot.png",
        mimeType: "image/png",
        proxyPath: expect.stringMatching(/^\/kanban\/attachment\/.+/),
      },
    ]);
    // The ADF media node's alt ("screenshot.png") matched the attachment's
    // filename, so the placeholder resolves to the proxy path instead of the
    // literal filename-as-URL.
    const proxyPath = result.detail?.attachments?.[0]?.proxyPath;
    expect(result.detail?.descriptionMarkdown).toBe(
      `Steps to reproduce\n\n![screenshot.png](${proxyPath})`,
    );

    // Cloud (email present) uses the v3 API, the ADF-returning endpoint.
    const issueCall = fetchImpl.mock.calls.find(([url]) =>
      (url as string).includes("/issue/PROJ-1?"),
    );
    expect(issueCall?.[0]).toContain("/rest/api/3/issue/PROJ-1");
  });

  test("fetches a Jira Server issue with a plain-text description body", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Server",
      baseUrl: "https://jira.internal.example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "pat-value",
    });
    await store.setConnectionAuthConnected(connection.id, true);
    await store.createSource({
      kind: "jira",
      name: "Jira Server",
      connectionId: connection.id,
      query: "project = PROJ",
    });
    const card = await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-2", project: "PROJ", issueKey: "PROJ-2" },
      {
        title: "Server issue",
        url: null,
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "jira",
      },
    );

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer pat-value");
      if (url.includes("/comment?maxResults=0")) {
        return jsonResponse(200, { total: 1, comments: [] });
      }
      expect(url).toContain("/rest/api/2/issue/PROJ-2");
      return jsonResponse(200, {
        key: "PROJ-2",
        fields: {
          summary: "Server issue",
          description: "*wiki markup* description",
          status: { name: "Open" },
        },
      });
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getDetail(card.id);

    expect(result.error).toBeNull();
    expect(result.detail?.descriptionMarkdown).toBe("*wiki markup* description");
    expect(result.detail?.commentCount).toBe(1);
    expect(result.detail?.attachments).toEqual([]);
  });

  test("getComments fetches and normalizes Jira comments (ADF, resolving a media reference)", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Cloud",
      baseUrl: "https://jira.example.com",
      email: "dev@example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "secret-token",
    });
    await store.setConnectionAuthConnected(connection.id, true);
    await store.createSource({
      kind: "jira",
      name: "Jira Cloud",
      connectionId: connection.id,
      query: "project = PROJ",
    });
    const card = await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-1", project: "PROJ", issueKey: "PROJ-1" },
      {
        title: "Fix the thing",
        url: "https://jira.example.com/browse/PROJ-1",
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "jira",
      },
    );

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("?fields=attachment")) {
        return jsonResponse(200, {
          key: "PROJ-1",
          fields: {
            attachment: [
              {
                id: "10001",
                filename: "diagram.png",
                mimeType: "image/png",
                content: "https://jira.example.com/secure/attachment/10001/diagram.png",
              },
            ],
          },
        });
      }
      return jsonResponse(200, {
        comments: [
          {
            author: { displayName: "Ada Lovelace" },
            created: "2024-01-02T00:00:00.000Z",
            body: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Looks good, see" }] },
                {
                  type: "mediaSingle",
                  content: [{ type: "media", attrs: { alt: "diagram.png" } }],
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getComments(card.id);

    expect(result.error).toBeNull();
    expect(result.comments).toHaveLength(1);
    expect(result.comments?.[0]?.author).toBe("Ada Lovelace");
    expect(result.comments?.[0]?.bodyMarkdown).toMatch(
      /^Looks good, see\n\n!\[diagram\.png\]\(\/kanban\/attachment\/.+\)$/,
    );
  });

  test("getComments returns plain-text Jira Server comment bodies", async () => {
    await store.createConnection({
      kind: "jira",
      name: "Jira Server",
      baseUrl: "https://jira.internal.example.com",
    });
    const connection = (await store.listConnections())[0];
    await secrets.set(credentialRefForConnection(connection.id), {
      method: "token",
      token: "pat-value",
    });
    await store.setConnectionAuthConnected(connection.id, true);
    await store.createSource({
      kind: "jira",
      name: "Jira Server",
      connectionId: connection.id,
      query: "project = PROJ",
    });
    const card = await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-2", project: "PROJ", issueKey: "PROJ-2" },
      {
        title: "Server issue",
        url: null,
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "jira",
      },
    );

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("?fields=attachment")) {
        return jsonResponse(200, { key: "PROJ-2", fields: {} });
      }
      return jsonResponse(200, {
        comments: [
          {
            author: { displayName: "Linus" },
            created: "2024-02-02T00:00:00.000Z",
            body: "plain text comment",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getComments(card.id);

    expect(result.error).toBeNull();
    expect(result.comments).toEqual([
      {
        author: "Linus",
        createdAt: "2024-02-02T00:00:00.000Z",
        bodyMarkdown: "plain text comment",
      },
    ]);
  });

  test("fetches a GitLab merge request without fetching notes", async () => {
    await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });
    const card = await store.upsertCardBySource(
      { kind: "gitlab", externalId: "gitlab:42!7", projectId: "42", mrIid: "7" },
      {
        title: "Add feature",
        url: "https://gitlab.example.com/-/merge_requests/7",
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "gitlab-mr",
      },
    );

    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        iid: 7,
        title: "Add feature",
        web_url: "https://gitlab.example.com/-/merge_requests/7",
        state: "opened",
        description: "**MR** description",
        author: { name: "Alice" },
        assignee: { name: "Bob" },
        labels: ["feature"],
        created_at: "2024-03-01T00:00:00.000Z",
        updated_at: "2024-03-03T00:00:00.000Z",
      }),
    ) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getDetail(card.id);

    expect(result.error).toBeNull();
    expect(result.detail).toMatchObject({
      title: "Add feature",
      externalStatus: "opened",
      assignee: "Bob",
      reporter: "Alice",
      labels: ["feature"],
      priority: null,
      descriptionMarkdown: "**MR** description",
      // GitLab's total-note count includes system notes, which getComments
      // filters out — see the commentCount comment in getGitlabDetail.
      commentCount: null,
    });
    // Detail no longer fetches notes at all; comments are lazy-loaded via
    // kanban.card.comments.request / getComments.
    expect(fetchImpl.mock.calls.some(([url]) => (url as string).includes("/notes"))).toBe(false);
  });

  test("getComments fetches GitLab notes and filters out system notes", async () => {
    await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });
    const card = await store.upsertCardBySource(
      { kind: "gitlab", externalId: "gitlab:42!7", projectId: "42", mrIid: "7" },
      {
        title: "Add feature",
        url: "https://gitlab.example.com/-/merge_requests/7",
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "gitlab-mr",
      },
    );

    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        {
          author: { name: "Bob" },
          body: "LGTM",
          created_at: "2024-03-02T00:00:00.000Z",
          system: false,
        },
        {
          author: { name: "GitLab Bot" },
          body: "changed the description",
          created_at: "2024-03-01T00:00:00.000Z",
          system: true,
        },
      ]),
    ) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getComments(card.id);

    expect(result.error).toBeNull();
    expect(result.comments).toEqual([
      { author: "Bob", createdAt: "2024-03-02T00:00:00.000Z", bodyMarkdown: "LGTM" },
    ]);
  });

  test("returns an error when the tracker responds with 404", async () => {
    await store.createSource({
      kind: "jira",
      name: "Jira",
      baseUrl: "https://jira.example.com",
      query: "project = PROJ",
    });
    const card = await store.upsertCardBySource(
      { kind: "jira", externalId: "jira:PROJ-9", project: "PROJ", issueKey: "PROJ-9" },
      {
        title: "Gone",
        url: null,
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "jira",
      },
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { errorMessages: ["Issue not found"] }),
    ) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getDetail(card.id);

    expect(result.detail).toBeNull();
    expect(result.error).toContain("404");
  });

  test("returns an error when the tracker responds with 401", async () => {
    await store.createSource({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.example.com",
      query: "state=opened",
    });
    const card = await store.upsertCardBySource(
      { kind: "gitlab", externalId: "gitlab:1!1", projectId: "1", mrIid: "1" },
      {
        title: "Unauthorized",
        url: null,
        status: "wip",
        columnId: (await store.listColumns())[0].id,
        theme: "gitlab-mr",
      },
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { message: "401 Unauthorized" }),
    ) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const result = await service.getDetail(card.id);

    expect(result.detail).toBeNull();
    expect(result.error).toContain("401");
  });

  test("attachment proxy tokens: fetchAttachment proxies the upstream response for a token minted by getDetail", async () => {
    const card = await seedJiraCardWithAttachment({ store, secrets });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/secure/attachment/")) {
        return fetchAttachmentBytes(init);
      }
      if (url.includes("/comment?maxResults=0")) {
        return jsonResponse(200, { total: 0, comments: [] });
      }
      return jsonResponse(200, jiraIssueWithAttachmentBody());
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({ store, secrets, fetchImpl });
    const detailResult = await service.getDetail(card.id);
    const proxyPath = detailResult.detail?.attachments?.[0]?.proxyPath;
    expect(proxyPath).toMatch(/^\/kanban\/attachment\/.+/);
    const token = proxyPath?.split("/").pop() ?? "";

    const attachmentResult = await service.fetchAttachment(token);
    expect(attachmentResult.status).toBe("ok");
    if (attachmentResult.status === "ok") {
      expect(attachmentResult.mimeType).toBe("image/png");
      expect(attachmentResult.response.headers.get("content-type")).toBe("image/png");
    }

    // Not single-use: the same detail page can re-render the same image.
    const secondFetch = await service.fetchAttachment(token);
    expect(secondFetch.status).toBe("ok");
  });

  test("attachment proxy tokens: fetchAttachment returns not_found for an unknown token", async () => {
    const service = new KanbanCardDetailService({
      store,
      secrets,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const result = await service.fetchAttachment("bogus-token");
    expect(result.status).toBe("not_found");
  });

  test("attachment proxy tokens: fetchAttachment returns not_found once the token has expired", async () => {
    let now = 0;
    const card = await seedJiraCardWithAttachment({ store, secrets });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/comment?maxResults=0")) {
        return jsonResponse(200, { total: 0, comments: [] });
      }
      return jsonResponse(200, jiraIssueWithAttachmentBody());
    }) as unknown as typeof fetch;

    const service = new KanbanCardDetailService({
      store,
      secrets,
      fetchImpl,
      attachmentTokenTtlMs: 1000,
      now: () => now,
    });
    const detailResult = await service.getDetail(card.id);
    const proxyPath = detailResult.detail?.attachments?.[0]?.proxyPath;
    const token = proxyPath?.split("/").pop() ?? "";

    now += 1001;
    const result = await service.fetchAttachment(token);
    expect(result.status).toBe("not_found");
  });
});
