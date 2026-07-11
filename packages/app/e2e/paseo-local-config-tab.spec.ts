import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "./fixtures";
import { seedWorkspace } from "./helpers/seed-client";
import {
  clickSaveProjectSettings,
  editWorktreeSetup,
  openProjects,
  openProjectSettings,
} from "./helpers/project-settings";

const initialPaseoConfig = {
  worktree: {
    setup: ["echo initial setup"],
    teardown: "echo cleanup",
  },
  scripts: {
    dev: { command: "npm run dev", type: "server", port: 3000 },
  },
};

interface LocalTabFixtures {
  editableProject: { name: string; path: string };
}

const test = base.extend<LocalTabFixtures>({
  editableProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "paseo-local-tab-",
      repo: { paseoConfig: initialPaseoConfig },
    });
    await provide({ name: workspace.projectDisplayName, path: workspace.repoPath });
    await workspace.cleanup();
  },
});

async function selectTarget(page: Page, label: string): Promise<void> {
  await page.getByTestId("project-config-target").getByText(label, { exact: true }).click();
}

async function readLocalConfig(repoPath: string): Promise<unknown> {
  const raw = await readFile(path.join(repoPath, "paseo.local.json"), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as unknown) : null;
}

test.describe("paseo.local.json edit tab", () => {
  test("edits the local override file without touching paseo.json", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Shared tab (default): shows the committed paseo.json setup command.
    await expect(page.getByTestId("project-config-target")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toHaveValue(
      "echo initial setup",
    );
    await page.screenshot({ path: "/tmp/paseo-local-shared-tab.png", fullPage: true });

    // Switch to the Local override tab. No paseo.local.json yet -> empty form.
    await selectTarget(page, "Local override");
    await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toHaveValue("");
    await page.screenshot({ path: "/tmp/paseo-local-empty-tab.png", fullPage: true });

    // Author a local-only setup command and save.
    await editWorktreeSetup(page, ["echo local-only"]);
    await clickSaveProjectSettings(page);

    // paseo.local.json is created with the override; paseo.json stays untouched.
    await expect
      .poll(() => readLocalConfig(editableProject.path), { timeout: 30_000 })
      .toMatchObject({ worktree: { setup: ["echo local-only"] } });

    const baseConfig = JSON.parse(
      await readFile(path.join(editableProject.path, "paseo.json"), "utf8"),
    ) as { worktree: { setup: string[] } };
    expect(baseConfig.worktree.setup).toEqual(["echo initial setup"]);

    await page.screenshot({ path: "/tmp/paseo-local-filled-tab.png", fullPage: true });

    // Switching back to Shared still shows the untouched base value.
    await selectTarget(page, "Shared");
    await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toHaveValue(
      "echo initial setup",
    );
  });
});
