import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../src/utils/host-routes";
import { test, expect } from "./fixtures";
import { openChangesPanel } from "./helpers/branch-switcher";
import { getServerId } from "./helpers/server-id";
import { connectSeedClient } from "./helpers/seed-client";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";

interface DirtyWorkspace {
  id: string;
}

interface CleanupTask {
  run: () => Promise<void>;
}

const cleanupTasks: CleanupTask[] = [];

// STR screenshots land outside the repo — debugging artifacts, not test fixtures.
const SCREENSHOT_DIR = "/tmp/diff-fontsize-str";

// A multi-line function edit so the diff body always has code rows to size.
const BEFORE = `export function renderApp(): string {
  const parts = ["app", "v1"];
  return parts.join(" ");
}
`;

const AFTER = `export function renderApp(): string {
  const parts = ["app", "v2", "with", "more", "output"];
  return parts.join(" ");
}
`;

test.beforeAll(async () => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
});

test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) {
    await task.run();
  }
});

test("diff text size steps re-render the diff and persist across reload", async ({ page }) => {
  // The size change round-trips through changes-preferences storage and re-lays out
  // the whole diff body; allow slack for a loaded machine running parallel suites.
  test.setTimeout(300_000);
  const workspace = await createWorkspaceWithFunctionDiff();
  await openAppDiff(page, workspace);

  // (a) Default step is `md`; capture the baseline rendered code font size.
  const baselineFontSize = await readDiffCodeFontSize(page);

  // (b) Open the diff options overflow menu — the "Text size" section lives there.
  await openOptionsMenu(page);
  await expect(page.getByTestId("changes-diff-font-size-label")).toContainText("Text size", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("changes-diff-font-size-md")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("changes-diff-font-size-xxxl")).toBeVisible({ timeout: 30_000 });
  await capture(page, "01-text-size-section.png");

  // (c) Pick the smallest step (xs): the rendered code font size must shrink below the
  // `md` baseline. The menu stays open on select (closeOnSelect=false), so close it to
  // show the smaller diff before asserting.
  await page.getByTestId("changes-diff-font-size-xs").click();
  await closeOptionsMenu(page);
  const xsFontSize = await expectDiffCodeFontSizeBelow(page, baselineFontSize);
  await capture(page, "02-xs-smaller.png");

  // (d) Pick the largest step (xxxl): the rendered code font size must grow past xs.
  await openOptionsMenu(page);
  await page.getByTestId("changes-diff-font-size-xxxl").click();
  await closeOptionsMenu(page);
  const xxxlFontSize = await expectDiffCodeFontSizeAbove(page, xsFontSize);
  expect(xxxlFontSize).toBeGreaterThan(baselineFontSize);
  await capture(page, "03-xxxl-larger.png");

  // (e) Persistence: the step lives in changes-preferences storage and must survive a
  // full page reload — the diff re-renders at xxxl without touching the menu again.
  await page.reload();
  await waitForWorkspaceTabsVisible(page);
  await ensureChangesPanelOpen(page);
  await openDiffBody(page);
  await expect.poll(async () => readDiffCodeFontSize(page), { timeout: 60_000 }).toBe(xxxlFontSize);
  await capture(page, "04-persisted-after-reload.png");
});

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
}

async function openOptionsMenu(page: Page): Promise<void> {
  await page.getByTestId("changes-options-menu").click();
  await expect(page.getByTestId("changes-options-menu-content")).toBeVisible({ timeout: 30_000 });
}

async function closeOptionsMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("changes-options-menu-content")).not.toBeVisible({
    timeout: 30_000,
  });
}

// The diff body's first rendered code line font size (px). Two renders at the same step
// share it, so a change proves the size step re-laid the pane out.
async function readDiffCodeFontSize(page: Page): Promise<number> {
  await expect(page.getByTestId("diff-code-text-1")).toBeVisible({ timeout: 30_000 });
  return page
    .getByTestId("diff-code-text-1")
    .evaluate((text) => Number.parseFloat(getComputedStyle(text).fontSize));
}

async function expectDiffCodeFontSizeBelow(page: Page, ceiling: number): Promise<number> {
  await expect
    .poll(async () => readDiffCodeFontSize(page), { timeout: 60_000 })
    .toBeLessThan(ceiling);
  return readDiffCodeFontSize(page);
}

async function expectDiffCodeFontSizeAbove(page: Page, floor: number): Promise<number> {
  await expect
    .poll(async () => readDiffCodeFontSize(page), { timeout: 60_000 })
    .toBeGreaterThan(floor);
  return readDiffCodeFontSize(page);
}

// The explorer's open state persists across reloads, so the Changes panel is usually
// already visible — a blind toggle would close it. Only toggle when it's absent.
async function ensureChangesPanelOpen(page: Page): Promise<void> {
  const changesHeader = page.getByTestId("changes-header").filter({ visible: true }).first();
  const alreadyOpen = await changesHeader
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (alreadyOpen) {
    return;
  }
  await openChangesPanel(page);
}

async function openDiffBody(page: Page): Promise<void> {
  await expect(page.getByText("app.ts")).toBeVisible({ timeout: 30_000 });
  const body = page.getByTestId("diff-file-0-body");
  if (await body.isVisible().catch(() => false)) {
    return;
  }
  await page.getByTestId("diff-file-0").click();
  await expect(body).toBeVisible({ timeout: 30_000 });
}

async function createWorkspaceWithFunctionDiff(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("diff-font-size-", {
    files: [{ path: "src/app.ts", content: BEFORE }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  await writeFile(path.join(repo.path, "src/app.ts"), AFTER);
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repo.path}`);
  }
  return { id: createdWorkspace.workspace.id };
}

async function openAppDiff(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  await openDiffBody(page);
  await expect(page.getByTestId("diff-code-text-1")).toBeVisible({ timeout: 30_000 });
}
