import { execSync } from "node:child_process";
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

// STR screenshots for the diff-engine/branch-compare journey land outside the
// repo on purpose — they are debugging artifacts, not test fixtures.
const SCREENSHOT_DIR = "/tmp/diff-engine-str";

// Bram Cohen's canonical patience-diff example: swapping `fact` for a new `fib`
// while trimming `frobnitz` is the classic input where Myers produces an
// interleaved remove/add soup but histogram (and structural engines) produce
// clean whole-function blocks. That guarantees every engine/algorithm switch in
// this spec renders a *different* row sequence we can assert on.
const BEFORE = `#include <stdio.h>

// Frobs foo heartily
int frobnitz(int foo)
{
    int i;
    for(i = 0; i < 10; i++)
    {
        printf("Your answer is: ");
        printf("%d\\n", foo);
    }
}

int fact(int n)
{
    if(n > 1)
    {
        return fact(n-1) * n;
    }
    return 1;
}

int main(int argc, char **argv)
{
    frobnitz(fact(10));
}
`;

const AFTER = `#include <stdio.h>

int fib(int n)
{
    if(n > 2)
    {
        return fib(n-1) + fib(n-2);
    }
    return 1;
}

// Frobs foo heartily
int frobnitz(int foo)
{
    int i;
    for(i = 0; i < 10; i++)
    {
        printf("%d\\n", foo);
    }
}

int main(int argc, char **argv)
{
    frobnitz(fib(10));
}
`;

const APP_BEFORE = `export function renderApp(): string {
  return "app v1";
}
`;

const APP_AFTER = `export function renderApp(): string {
  return "app v2 with more output";
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

test("diff engine switching re-renders per engine and persists the choice", async ({ page }) => {
  // Engine switches round-trip through the daemon (recompute + push); allow for
  // a loaded machine running parallel suites.
  test.setTimeout(300_000);
  const workspace = await createWorkspaceWithReorderedFunctionDiff();
  await openFrobnitzDiff(page, workspace);

  // (a) Default engine is git; capture the baseline (implicit Myers) rendering.
  await expectEngineTriggerLabel(page, "Git");
  const gitDefaultSignature = await readDiffRowSignature(page);
  expect(gitDefaultSignature).toContain("frobnitz");
  await capture(page, "01-git-default-engine.png");

  // (b) Open the engine menu, switch to vscode: the diff must re-render in
  // place (no reload) with a different row sequence — the vscode engine emits
  // clean whole-function blocks where Myers interleaves.
  await page.evaluate(() => {
    (window as unknown as { __diffEngineNoReloadMarker?: boolean }).__diffEngineNoReloadMarker =
      true;
  });
  await openEngineMenu(page);
  await capture(page, "02-engine-menu-open.png");
  await page.getByTestId("changes-diff-engine-vscode").click();
  await expectEngineMenuClosed(page);
  await expectEngineTriggerLabel(page, "VS Code");
  await expectSignatureChange(page, gitDefaultSignature);
  const vscodeSignature = await readDiffRowSignature(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __diffEngineNoReloadMarker?: boolean })
          .__diffEngineNoReloadMarker === true,
    ),
    "engine switch must not reload the page",
  ).toBe(true);
  await capture(page, "03-vscode-engine.png");

  // (c) Git algorithm switch: explicit Myers first, then histogram. On this
  // fixture the two algorithms provably produce different unified diffs, so a
  // rendered row-sequence change is the re-render proof.
  await openEngineMenu(page);
  await page.getByTestId("changes-diff-engine-algorithm-myers").click();
  await expectEngineMenuClosed(page);
  await expectEngineTriggerLabel(page, "Git");
  await expectSignatureChange(page, vscodeSignature);
  const myersSignature = await readDiffRowSignature(page);

  await openEngineMenu(page);
  await page.getByTestId("changes-diff-engine-algorithm-histogram").click();
  await expectEngineMenuClosed(page);
  await expectSignatureChange(page, myersSignature);
  const histogramSignature = await readDiffRowSignature(page);
  expect(histogramSignature).not.toBe(myersSignature);
  await capture(page, "04-git-histogram-vs-myers.png");

  // (d) Difftastic: available only when the daemon detects a difft binary
  // (PATH or PASEO_DIFFT_PATH). When available, its structural output must
  // render differently from git's line diff and carry server-computed
  // word-level ranges. Otherwise assert the degraded menu state instead.
  await openEngineMenu(page);
  const difftasticItem = page.getByTestId("changes-diff-engine-difftastic");
  await expect(difftasticItem).toBeVisible({ timeout: 30_000 });
  const difftasticLabel = (await difftasticItem.textContent()) ?? "";
  const difftasticAvailable = difftasticLabel.trim() === "Difftastic";
  let persistedEngineLabel: string;
  if (difftasticAvailable) {
    await difftasticItem.click();
    await expectEngineMenuClosed(page);
    await expectEngineTriggerLabel(page, "Difftastic");
    await expectSignatureChange(page, histogramSignature);
    // Server-provided word-level ranges: the paired `frobnitz(fact(10))` →
    // `frobnitz(fib(10))` line highlights only the changed call token.
    const changed = page.locator("[data-diff-word-changed]");
    await expect(changed.first()).toBeVisible({ timeout: 30_000 });
    await expect(changed.filter({ hasText: "fact" }).first()).toBeVisible({ timeout: 30_000 });
    await capture(page, "05-difftastic-engine.png");
    persistedEngineLabel = "Difftastic";
  } else {
    // Degraded environment: menu item shows "Install difftastic…" (installable)
    // or a disabled unavailable entry. Record it and fall back to vscode for
    // the persistence leg.
    test.info().annotations.push({
      type: "difftastic-degraded",
      description: `difftastic engine not available in daemon (menu item: "${difftasticLabel.trim()}")`,
    });
    await capture(page, "05-difftastic-not-available.png");
    await page.keyboard.press("Escape");
    await expectEngineMenuClosed(page);
    await openEngineMenu(page);
    await page.getByTestId("changes-diff-engine-vscode").click();
    await expectEngineMenuClosed(page);
    await expectEngineTriggerLabel(page, "VS Code");
    persistedEngineLabel = "VS Code";
  }

  // (f) Persistence: the engine choice lives in changes-preferences storage and
  // must survive a full page reload.
  await page.reload();
  await waitForWorkspaceTabsVisible(page);
  await ensureChangesPanelOpen(page);
  await expectEngineTriggerLabel(page, persistedEngineLabel);
  await expect(page.getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });
  await capture(page, "08-persistence-after-reload.png");
});

test("compare with branch renders the branch delta and merge-base toggle", async ({ page }) => {
  test.setTimeout(300_000);
  const workspace = await createWorkspaceWithCompareBranch();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);

  // (e) Open the compare dropdown and pick "Compare with branch…".
  await page.getByTestId("changes-diff-status").click();
  await expect(page.getByTestId("changes-diff-status-menu")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("changes-diff-mode-branch").click();

  const picker = page.getByTestId("combobox-desktop-container");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  const search = page.getByPlaceholder("Filter branches...");
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill("compare-target");
  const option = picker.getByText("compare-target", { exact: true });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(picker).not.toBeVisible({ timeout: 30_000 });

  // Default merge-base semantics ("Only changes on this branch"): only HEAD's
  // own commit since the fork point is shown — the branch marker file is not.
  await expect(page.getByTestId("changes-diff-status")).toContainText("vs compare-target", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("changes-branch-compare-merge-base")).toContainText(
    "Only changes on this branch",
    { timeout: 30_000 },
  );
  await expect(page.getByText("app.ts")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(BRANCH_MARKER_FILE)).toHaveCount(0);
  await capture(page, "06-branch-compare.png");

  // Toggle to "Full diff" (two-point compare): now the branch-only marker file
  // enters the diff too — visible proof the toggle recomputed the compare.
  await page.getByTestId("changes-branch-compare-merge-base").click();
  await expect(page.getByTestId("changes-branch-compare-merge-base")).toContainText("Full diff", {
    timeout: 30_000,
  });
  await expect(page.getByText(BRANCH_MARKER_FILE)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("app.ts")).toBeVisible({ timeout: 30_000 });
  await capture(page, "07-branch-compare-merge-base-full.png");
});

// createTempGitRepo names branch marker files `.paseo-e2e-<sanitized-branch>.txt`.
const BRANCH_MARKER_FILE = ".paseo-e2e-compare-target.txt";

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
}

// The explorer's open state persists across reloads, so after page.reload()
// the Changes panel is usually already visible — openChangesPanel's blind
// toggle click would then close it instead. Only toggle when it's not there.
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

async function openEngineMenu(page: Page): Promise<void> {
  await page.getByTestId("changes-diff-engine").click();
  await expect(page.getByTestId("changes-diff-engine-menu")).toBeVisible({ timeout: 30_000 });
}

async function expectEngineMenuClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("changes-diff-engine-menu")).not.toBeVisible({ timeout: 30_000 });
}

async function expectEngineTriggerLabel(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId("changes-diff-engine")).toContainText(label, { timeout: 30_000 });
}

// The diff body's ordered "<gutter>|<code>" row sequence. Two renders of the
// same file diff produce the same signature, so a signature change after an
// engine/algorithm switch proves the daemon recomputed and the pane
// re-rendered — without depending on colors or engine-internal markup.
async function readDiffRowSignature(page: Page): Promise<string> {
  await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });
  return page.getByTestId("diff-file-0-body").evaluate((root) => {
    const readIndexed = (prefix: string) =>
      Array.from(root.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
        .map((element) => ({
          index: Number((element.getAttribute("data-testid") ?? "").slice(prefix.length)),
          text: element.textContent ?? "",
        }))
        .sort((left, right) => left.index - right.index);
    const gutters = new Map(readIndexed("diff-gutter-text-").map((row) => [row.index, row.text]));
    return readIndexed("diff-code-text-")
      .map((row) => `${gutters.get(row.index) ?? "?"}|${row.text}`)
      .join("\n");
  });
}

async function expectSignatureChange(page: Page, previousSignature: string): Promise<void> {
  await expect
    .poll(async () => readDiffRowSignature(page), { timeout: 60_000 })
    .not.toBe(previousSignature);
}

async function createWorkspaceWithReorderedFunctionDiff(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("diff-engine-switch-", {
    files: [{ path: "src/frobnitz.c", content: BEFORE }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  await writeFile(path.join(repo.path, "src/frobnitz.c"), AFTER);
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repo.path}`);
  }
  return { id: createdWorkspace.workspace.id };
}

// A clean repo (no uncommitted changes) with:
//   - `compare-target` branch: one marker-file commit off the fork point
//   - `main`: one committed change to src/app.ts after the fork point
// Merge-base compare shows only main's app.ts change; full diff also pulls in
// the branch-only marker file.
async function createWorkspaceWithCompareBranch(): Promise<DirtyWorkspace> {
  const repo = await createTempGitRepo("diff-branch-compare-", {
    files: [{ path: "src/app.ts", content: APP_BEFORE }],
    branches: ["compare-target"],
  });
  await writeFile(path.join(repo.path, "src/app.ts"), APP_AFTER);
  execSync("git add src/app.ts", { cwd: repo.path, stdio: "ignore" });
  execSync('git commit -m "Update app on main"', { cwd: repo.path, stdio: "ignore" });

  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repo.path}`);
  }
  return { id: createdWorkspace.workspace.id };
}

async function openFrobnitzDiff(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  await expect(page.getByText("frobnitz.c")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("diff-file-0").click();
  await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("int frobnitz(int foo)").first()).toBeVisible({ timeout: 30_000 });
}
