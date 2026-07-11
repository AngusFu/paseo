import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { expectStableHeight } from "./helpers/settled";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { buildSchedulesRoute } from "../src/utils/host-routes";

interface CommandScheduleListItem {
  id: string;
  name: string | null;
  prompt: string;
  target: {
    type: string;
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  };
}

interface CommandScheduleSeedClient {
  scheduleList(): Promise<{ schedules: CommandScheduleListItem[]; error: string | null }>;
  scheduleDelete(input: { id: string }): Promise<{ error: string | null }>;
}

async function deleteScheduleByName(workspace: SeededWorkspace, name: string): Promise<void> {
  const client = workspace.client as unknown as CommandScheduleSeedClient;
  const list = await client.scheduleList();
  const schedule = list.schedules.find((candidate) => candidate.name === name);
  if (schedule) {
    await client.scheduleDelete({ id: schedule.id }).catch(() => undefined);
  }
}

async function openNewScheduleSheet(page: Page): Promise<void> {
  await page.getByTestId("schedules-empty-new").click();
  const formSheet = page.getByTestId("schedule-form-sheet");
  await expect(formSheet).toBeVisible({ timeout: 10_000 });
  await expectStableHeight(formSheet);
}

test.describe("Schedules command target", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("creates a command schedule with an env var and timeout", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "schedule-command-target-", git: false });
    cleanupTasks.push(() => workspace.cleanup());
    const scheduleName = `Command schedule ${Date.now()}`;
    cleanupTasks.push(() => deleteScheduleByName(workspace, scheduleName));

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.goto(buildSchedulesRoute());
    await expect(page.getByTestId("schedules-empty-new")).toBeVisible({ timeout: 30_000 });

    await openNewScheduleSheet(page);

    // Switch the target kind to Command; the agent-only fields disappear.
    await page.getByTestId("schedule-kind-command").click();
    await expect(page.getByTestId("schedule-prompt-input")).toHaveCount(0);
    await expect(page.getByTestId("schedule-model-trigger")).toHaveCount(0);

    await page.getByRole("button", { name: /select project/i }).click();
    await page.getByTestId(`schedule-project-option-${workspace.projectId}`).click();
    const projectTrigger = page.getByTestId("schedule-project-trigger");
    await expect(projectTrigger).toContainText(workspace.projectDisplayName);

    await page.getByTestId("schedule-command-input").fill("npm run build");

    await page.getByTestId("schedule-command-env-add").click();
    await page.getByTestId("schedule-command-env-key-env-0").fill("NODE_ENV");
    await page.getByTestId("schedule-command-env-value-env-0").fill("production");

    await page.getByTestId("schedule-command-timeout-input").fill("30");

    await page.getByTestId("schedule-cadence-preset-trigger").click();
    await page.getByTestId("schedule-cadence-preset-daily-9").click();
    await expect(page.getByTestId("cadence-cron-expression")).toHaveValue("0 9 * * *");

    await page.getByLabel("Schedule name").fill(scheduleName);
    await page.getByRole("button", { name: "Create schedule" }).click();

    await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0, { timeout: 30_000 });

    const client = workspace.client as unknown as CommandScheduleSeedClient;
    const list = await client.scheduleList();
    const schedule = list.schedules.find((candidate) => candidate.name === scheduleName);
    expect(schedule).toEqual(
      expect.objectContaining({
        name: scheduleName,
        prompt: "npm run build",
        target: expect.objectContaining({
          type: "command",
          command: "npm run build",
          cwd: workspace.repoPath,
          env: expect.objectContaining({ NODE_ENV: "production" }),
          timeoutMs: 30_000,
        }),
      }),
    );
  });
});
