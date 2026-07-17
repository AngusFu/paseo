process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  clipboard,
  Menu,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  WebContentsView,
  webContents,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupCrossDisplayRasterFix,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  setupDragDropPrevention,
  buildStandardContextMenuItems,
} from "./window/window-manager.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { registerCodeServerHandlers, shutdownCodeServer } from "./features/code-server.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContents,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWebviewRegistry,
  listRegisteredPaseoBrowserIds,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  PendingBrowserWindowOpenRequests,
  registerBrowserWebviewNavigationGuards,
  unregisterPaseoBrowserFromHost,
  registerAttachedPaseoBrowser,
  setWorkspaceActivePaseoBrowserId,
  unregisterPaseoBrowserHost,
} from "./features/browser-webviews/index.js";
import {
  importCookiesFromChrome,
  listChromeProfiles,
} from "./features/browser-cookie-import/import-service.js";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  PASEO_BROWSER_PROFILE_PARTITION,
  getPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
} from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { PendingOpenProjectStore } from "./pending-open-project-store.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { autoUpdateInstalledSkills } from "./integrations/skills/index.js";
import { registerBrowserAutomationIpc } from "./features/browser-automation/ipc.js";
import { BrowserKeyboard } from "./features/browser-keyboard/index.js";
import { installAppUpdateOnQuit } from "./features/auto-updater.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "Paseo";
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const pendingBrowserWindowOpenRequests = new PendingBrowserWindowOpenRequests();

app.setName(APP_NAME);

interface AttachedBrowserInput {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function readAttachedBrowserInput(input: unknown): AttachedBrowserInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || record.browserId.trim().length === 0) {
    return null;
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  if (
    typeof record.webContentsId !== "number" ||
    !Number.isInteger(record.webContentsId) ||
    record.webContentsId <= 0
  ) {
    return null;
  }
  return {
    browserId: record.browserId.trim(),
    workspaceId: record.workspaceId.trim(),
    webContentsId: record.webContentsId,
  };
}

function readActiveBrowserInput(
  input: unknown,
): { workspaceId: string; browserId: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  const browserId = typeof record.browserId === "string" ? record.browserId.trim() : null;
  return { workspaceId: record.workspaceId.trim(), browserId: browserId || null };
}

const browserKeyboard = new BrowserKeyboard(getPaseoBrowserWebviewRegistry());
browserKeyboard.registerIpc();

function showBrowserWebviewContextMenu(
  win: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const menu = Menu.buildFromTemplate([
    ...buildStandardContextMenuItems(contents, params),
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          {
            label: "Inspect Element",
            click: () => {
              log.info("[browser-devtools] inspect-element.request", {
                webContentsId: contents.id,
                browserId: getPaseoBrowserIdForWebContents(contents),
                x: params.x,
                y: params.y,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
              contents.openDevTools({ mode: "detach" });
              contents.inspectElement(params.x, params.y);
              log.info("[browser-devtools] inspect-element.done", {
                webContentsId: contents.id,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
            },
          },
        ]),
  ]);
  menu.popup({ window: win });
}

function getBrowserPopupWindowOptions(
  mainWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PASEO_BROWSER_PROFILE_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}

function installBrowserWindowOpenHandler(input: {
  contents: Electron.WebContents;
  sourceContents: Electron.WebContents;
  mainWindow: BrowserWindow;
}): void {
  const { contents, sourceContents, mainWindow } = input;

  contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
    const decision = decideBrowserWindowOpenRequest({
      url,
      disposition,
      frameName,
      features,
      hasPostBody: postBody !== undefined && postBody !== null,
    });

    if (decision.kind === "deny") {
      return { action: "deny" };
    }
    if (decision.kind === "popup") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: getBrowserPopupWindowOptions(mainWindow),
      };
    }

    const sourceBrowserId = getPaseoBrowserIdForWebContents(sourceContents);
    if (sourceBrowserId) {
      mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
        sourceBrowserId,
        url: decision.url,
      });
    } else {
      pendingBrowserWindowOpenRequests.add(sourceContents.id, decision.url);
    }
    return { action: "deny" };
  });

  contents.on("did-create-window", (popupWindow) => {
    const popupContents = popupWindow.webContents;
    registerBrowserWebviewNavigationGuards(popupContents);
    popupContents.on("context-menu", (_event, params) => {
      showBrowserWebviewContextMenu(popupWindow, popupContents, params);
    });
    installBrowserWindowOpenHandler({
      contents: popupContents,
      sourceContents,
      mainWindow,
    });
  });
}

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
if (forcedUserDataDir) {
  app.setPath("userData", forcedUserDataDir);
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (!app.isPackaged) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "paseo") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (isWorktree) {
      app.setPath("userData", path.join(app.getPath("appData"), `Paseo-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// AppImage runtimes mount the app from /tmp under the user's UID, so the SUID
// chrome-sandbox helper we ship in .deb/.rpm cannot work there. Disable the
// sandbox only in that case; .deb/.rpm keep the sandbox on, matching VS Code.
if (process.platform === "linux" && process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Allow users to pass Chromium flags via PASEO_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
const pendingOpenProjectStore = new PendingOpenProjectStore();

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = pendingOpenProjectStore.take(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

function normalizeBrowserCaptureRect(
  rect: unknown,
): { x: number; y: number; width: number; height: number } | null {
  if (!rect || typeof rect !== "object") {
    return null;
  }
  const candidate = rect as Record<string, unknown>;
  const x = candidate.x;
  const y = candidate.y;
  const width = candidate.width;
  const height = candidate.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

ipcMain.handle("paseo:browser:register-attached", (event, rawInput: unknown) => {
  const input = readAttachedBrowserInput(rawInput);
  if (!input) {
    throw new Error("Invalid attached browser registration");
  }
  const registered = registerAttachedPaseoBrowser({
    ...input,
    sender: event.sender,
    profileSession: getPaseoBrowserProfileSession(session),
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) {
    throw new Error("Attached browser registration was rejected");
  }
  const guest = webContents.fromId(input.webContentsId);
  if (!guest) {
    throw new Error("Attached browser guest disappeared after registration");
  }
  browserKeyboard.attach({ contents: guest, hostContents: event.sender });
  log.info("[browser-webview] registered", {
    browserId: input.browserId,
    webContentsId: input.webContentsId,
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  for (const url of pendingBrowserWindowOpenRequests.take(input.webContentsId)) {
    event.sender.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
      sourceBrowserId: input.browserId,
      url,
    });
  }
});

ipcMain.handle("paseo:browser:unregister-workspace-browser", async (event, browserId: unknown) => {
  if (typeof browserId === "string" && browserId.trim().length > 0) {
    const normalizedBrowserId = browserId.trim();
    closeInlineDevtoolsForBrowser(normalizedBrowserId);
    const hasOtherHost = getPaseoBrowserWebviewRegistry().hasBrowserInOtherHostWindow(
      event.sender.id,
      normalizedBrowserId,
    );
    unregisterPaseoBrowserFromHost(event.sender.id, normalizedBrowserId);
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    const legacyProfile = hasOtherHost
      ? null
      : getLegacyPaseoBrowserProfileSession(session, normalizedBrowserId);
    if (legacyProfile) {
      try {
        await clearPaseoBrowserProfile({
          profileSessions: [legacyProfile],
          listGuests: () => [],
          logReloadError: () => {},
        });
      } catch (error) {
        log.warn("[browser-profile] failed to clear legacy tab profile", {
          browserId: normalizedBrowserId,
          error,
        });
      }
    }
  }
});

ipcMain.handle("paseo:browser:set-workspace-active-browser", (event, rawInput: unknown) => {
  const input = readActiveBrowserInput(rawInput);
  if (input) {
    setWorkspaceActivePaseoBrowserId({ ...input, hostWebContentsId: event.sender.id });
  }
});

ipcMain.handle("paseo:browser:open-devtools", (event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    const result = {
      ok: false,
      reason: "invalid-browser-id",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.invalid", result);
    return result;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.not-found", result);
    return result;
  }
  log.info("[browser-devtools] open-devtools.request", {
    browserId,
    webContentsId: contents.id,
    isDestroyed: contents.isDestroyed(),
    isDevToolsOpened: contents.isDevToolsOpened(),
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  contents.openDevTools({ mode: "detach" });
  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: contents.id,
    isDevToolsOpened: contents.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:list-chrome-profiles", () => {
  try {
    return { ok: true, profiles: listChromeProfiles() };
  } catch (error) {
    log.warn("[browser-cookie-import] list-chrome-profiles.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unexpected-error", profiles: [] };
  }
});

ipcMain.handle("paseo:browser:import-cookies-from-chrome", async (_event, rawInput: unknown) => {
  const input = rawInput as { browserId?: unknown; profileId?: unknown } | null;
  const browserId = typeof input?.browserId === "string" ? input.browserId.trim() : "";
  const profileId = typeof input?.profileId === "string" ? input.profileId.trim() : "";
  if (browserId.length === 0 || profileId.length === 0) {
    const result = { ok: false as const, reason: "invalid-input" };
    log.warn("[browser-cookie-import] import.invalid", { browserId, profileId });
    return result;
  }
  log.info("[browser-cookie-import] import.request", { browserId, profileId });
  const result = await importCookiesFromChrome({ browserId, profileId });
  log.info("[browser-cookie-import] import.done", { browserId, profileId, result });
  return result;
});

// Inline DevTools host views, keyed by browserId. A <webview> guest cannot dock
// its DevTools (Electron forces detach mode), so we host the DevTools front-end
// in a main-process WebContentsView floated over the window at the panel's rect.
// The guest is parked on a 1px host and shown via compositor capture; this view
// is a real child view at absolute window (DIP) coordinates, so it lands exactly
// where the empty panel box is in the renderer.
const inlineDevtoolsViews = new Map<
  string,
  { view: WebContentsView; guestWcId: number; window: BrowserWindow }
>();

function normalizeDevtoolsBounds(bounds: unknown): Electron.Rectangle | null {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }
  const candidate = bounds as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

// Tear down the inline DevTools host for a browser: close the guest's DevTools,
// remove the view from the window, and destroy the host WebContents (the caller
// owns its destruction per setDevToolsWebContents' contract). Idempotent.
function closeInlineDevtoolsForBrowser(browserId: string): void {
  const entry = inlineDevtoolsViews.get(browserId);
  if (!entry) {
    return;
  }
  inlineDevtoolsViews.delete(browserId);
  try {
    const guest = getPaseoBrowserWebContents(browserId);
    if (guest && !guest.isDestroyed() && guest.devToolsWebContents) {
      guest.closeDevTools();
    }
  } catch (error) {
    log.warn("[browser-devtools] inline.close-devtools-failed", {
      browserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (!entry.window.isDestroyed()) {
      entry.window.contentView.removeChildView(entry.view);
    }
  } catch (error) {
    log.warn("[browser-devtools] inline.remove-view-failed", {
      browserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }
  } catch (error) {
    log.warn("[browser-devtools] inline.destroy-host-failed", {
      browserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

ipcMain.handle("paseo:browser:open-inline-devtools", (event, rawInput: unknown) => {
  const input =
    rawInput && typeof rawInput === "object"
      ? (rawInput as { browserId?: unknown; bounds?: unknown })
      : {};
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const bounds = normalizeDevtoolsBounds(input.bounds);
  if (browserId.length === 0 || bounds === null) {
    const result = { ok: false, reason: "invalid-input", browserId, bounds: input.bounds };
    log.warn("[browser-devtools] open-inline-devtools.invalid", result);
    return result;
  }
  const guest = getPaseoBrowserWebContents(browserId);
  if (!guest) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-inline-devtools.not-found", result);
    return result;
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) {
    const result = { ok: false, reason: "owner-window-not-found", browserId };
    log.warn("[browser-devtools] open-inline-devtools.no-window", result);
    return result;
  }

  // Already open: just reposition the existing host view.
  const existing = inlineDevtoolsViews.get(browserId);
  if (existing) {
    try {
      existing.view.setBounds(bounds);
    } catch {}
    return { ok: true, reason: "already-open", browserId, webContentsId: guest.id };
  }

  // Fresh, never-navigated host WebContents (no options => own WebContents).
  // Never loadURL it, so the setDevToolsWebContents navigation-free contract holds.
  const view = new WebContentsView();
  window.contentView.addChildView(view);
  view.setBounds(bounds);
  view.setBackgroundColor("#00000000");
  guest.setDevToolsWebContents(view.webContents);
  guest.openDevTools();
  inlineDevtoolsViews.set(browserId, { view, guestWcId: guest.id, window });

  const cleanup = () => closeInlineDevtoolsForBrowser(browserId);
  guest.once("devtools-closed", cleanup);
  guest.once("destroyed", cleanup);

  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: guest.id,
    isDevToolsOpened: guest.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-inline-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:set-devtools-bounds", (_event, rawInput: unknown) => {
  const input =
    rawInput && typeof rawInput === "object"
      ? (rawInput as { browserId?: unknown; bounds?: unknown })
      : {};
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const bounds = normalizeDevtoolsBounds(input.bounds);
  if (browserId.length === 0 || bounds === null) {
    return { ok: false, reason: "invalid-input", browserId };
  }
  const entry = inlineDevtoolsViews.get(browserId);
  if (!entry) {
    return { ok: false, reason: "not-open", browserId };
  }
  try {
    entry.view.setBounds(bounds);
  } catch (error) {
    return {
      ok: false,
      reason: "set-bounds-failed",
      browserId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, browserId };
});

ipcMain.handle("paseo:browser:close-devtools", (_event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return { ok: false, reason: "invalid-browser-id", browserId };
  }
  const id = browserId.trim();
  const hadInline = inlineDevtoolsViews.has(id);
  // Tear down the inline host view (also closes the guest's DevTools).
  closeInlineDevtoolsForBrowser(id);
  // For a detached DevTools session there is no inline view; close it directly.
  if (!hadInline) {
    const contents = getPaseoBrowserWebContents(id);
    if (contents && !contents.isDestroyed()) {
      contents.closeDevTools();
    }
  }
  const result = { ok: true, reason: "closed", browserId: id };
  log.info("[browser-devtools] close-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:clear-profile", async (_event, rawLegacyBrowserIds: unknown) => {
  const profileSessions = getPaseoBrowserProfileSessions(
    session,
    readLegacyPaseoBrowserIds(rawLegacyBrowserIds),
  );
  const profileSession = profileSessions[0];
  await clearPaseoBrowserProfile({
    profileSessions,
    listGuests: () =>
      listPaseoBrowserProfileGuests({
        profileSession,
        webContents: webContents.getAllWebContents(),
      }),
    logReloadError: (webContentsId, error) => {
      log.warn("[browser-profile] failed to reload guest", { webContentsId, error });
    },
  });
});

ipcMain.handle(
  "paseo:browser:capture-element",
  async (event, browserId: unknown, rect: unknown) => {
    if (typeof browserId !== "string" || browserId.trim().length === 0) {
      return null;
    }
    const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
    if (!contents || contents.isDestroyed()) {
      return null;
    }
    const captureRect = normalizeBrowserCaptureRect(rect);
    if (!captureRect) {
      return null;
    }
    try {
      // capturePage expects an integer rect in CSS pixels relative to the
      // guest viewport, which matches getBoundingClientRect() on the page.
      const image = await contents.capturePage(captureRect);
      if (image.isEmpty()) {
        return null;
      }
      return image.toDataURL();
    } catch (error) {
      log.warn("[browser-capture] capture-element.failed", {
        browserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },
);

ipcMain.handle("paseo:browser:copy-element", (_event, payload: unknown): boolean => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const { text, imageDataUrl } = payload as { text?: unknown; imageDataUrl?: unknown };
  const copyText = typeof text === "string" && text.length > 0 ? text : null;

  // Resolve the image first so we can write the clipboard exactly once and
  // avoid flashing an intermediate text-only state.
  let image: Electron.NativeImage | null = null;
  if (typeof imageDataUrl === "string" && imageDataUrl.startsWith("data:image")) {
    try {
      const candidate = nativeImage.createFromDataURL(imageDataUrl);
      if (!candidate.isEmpty()) {
        image = candidate;
      }
    } catch (error) {
      log.warn("[browser-capture] copy-element.image-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Writing from the main process avoids the renderer's navigator.clipboard
  // NotAllowedError, which fires when focus is inside the guest <webview>.
  if (copyText && image) {
    clipboard.write({ text: copyText, image });
    return true;
  }
  if (image) {
    clipboard.writeImage(image);
    return true;
  }
  if (copyText) {
    clipboard.writeText(copyText);
    return true;
  }
  return false;
});

// Force the guest page's `prefers-color-scheme` via CDP media emulation.
// "system" clears the override. Emulation resets on cross-document navigation,
// so the renderer re-applies a non-system choice on each dom-ready.
ipcMain.handle("paseo:browser:set-color-scheme", async (_event, rawInput: unknown) => {
  const input =
    rawInput && typeof rawInput === "object"
      ? (rawInput as { browserId?: unknown; scheme?: unknown })
      : {};
  const browserId = typeof input.browserId === "string" ? input.browserId.trim() : "";
  const scheme =
    input.scheme === "dark" || input.scheme === "light" || input.scheme === "system"
      ? input.scheme
      : null;
  if (browserId.length === 0 || scheme === null) {
    return { ok: false, reason: "invalid-input", browserId, scheme: input.scheme };
  }
  const contents = getPaseoBrowserWebContents(browserId);
  if (!contents || contents.isDestroyed()) {
    return { ok: false, reason: "browser-webcontents-not-found", browserId };
  }
  try {
    // Reuse an existing debugger session (the automation subsystem may already
    // own it); attach only if nobody has. Never detach — automation relies on it.
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    const features = scheme === "system" ? [] : [{ name: "prefers-color-scheme", value: scheme }];
    await contents.debugger.sendCommand("Emulation.setEmulatedMedia", { features });
    return { ok: true, browserId, scheme };
  } catch (error) {
    log.warn("[browser-color-scheme] set-color-scheme.failed", {
      browserId,
      scheme,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "cdp-command-failed", browserId, scheme };
  }
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getBrowserKeyboardPreloadPath(): string {
  return path.join(__dirname, "features", "browser-keyboard", "guest-preload.js");
}

function getAppDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }

  return path.resolve(__dirname, "../../app/dist");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [path.resolve(__dirname, "../assets/icon.png")];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function applyAppIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const iconPath = path.resolve(__dirname, "../assets/icon.png");
  if (!existsSync(iconPath)) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

async function createWindow(
  options: {
    pendingOpenProjectPath?: string | null;
    restoreWindowState?: boolean;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;

  const title = devWorktreeName ? `${APP_NAME} (${devWorktreeName})` : APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      platform: process.platform,
      theme: systemTheme,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const webContentsId = mainWindow.webContents.id;
  pendingOpenProjectStore.set(webContentsId, options.pendingOpenProjectPath);
  mainWindow.on("closed", () => {
    pendingOpenProjectStore.delete(webContentsId);
    unregisterPaseoBrowserHost(webContentsId);
    browserKeyboard.detachHost(webContentsId);
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  setupCrossDisplayRasterFix(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isPaseoBrowserWebviewAttach(params)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    // The sandboxed keyboard preload must run in every frame so focused iframes keep
    // the same page-first shortcut boundary. Node integration remains disabled.
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.webviewTag = false;
    webPreferences.allowRunningInsecureContent = false;
    delete webPreferences.preload;
    delete params.preload;
    delete (webPreferences as { preloadURL?: string }).preloadURL;
    delete (params as { preloadURL?: string }).preloadURL;
    webPreferences.preload = getBrowserKeyboardPreloadPath();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    preparePaseoBrowserWebContents(contents);
    contents.once("destroyed", () => {
      pendingBrowserWindowOpenRequests.delete(contents.id);
    });
    installBrowserWindowOpenHandler({
      contents,
      sourceContents: contents,
      mainWindow,
    });
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    registerBrowserWebviewNavigationGuards(contents);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    await mainWindow.loadURL(DEV_SERVER_URL);
    return mainWindow;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app/`);
  return mainWindow;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Resolves once bootstrap() has registered the custom protocol handler and IPC
// handlers and created the first window. second-instance window creation waits
// on this rather than app.whenReady(): in packaged mode createWindow loads
// `paseo://app/`, which fails if the protocol handler isn't registered yet, and
// a second instance can arrive mid-cold-start.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});

function setupSingleInstanceLock(): boolean {
  if (DISABLE_SINGLE_INSTANCE_LOCK) {
    log.info("[single-instance] disabled by PASEO_DISABLE_SINGLE_INSTANCE_LOCK");
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", (_event, commandLine) => {
    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // Relaunching the app (CLI `paseo [path]`, double-click, etc.) opens a new
    // window rather than focusing the existing one. Wait for bootstrap (not just
    // app.whenReady) so the protocol + IPC handlers exist before the window loads.
    void bootstrapComplete
      .then(() => createWindow({ pendingOpenProjectPath: openProjectPath }))
      .catch((error) => {
        log.error("[window] failed to create window from second-instance", error);
      });
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();

  const appDistDir = getAppDistDir();
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname, search, hash } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);

    // Chromium can occasionally request the exported entrypoint directly.
    // Canonicalize it back to the route URL so Expo Router sees `/`, not `/index.html`.
    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback: serve index.html for routes without a file extension
    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  applyAppIcon();
  setupApplicationMenu({
    onNewWindow: () => {
      void createWindow().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  registerEditorTargetHandlers();
  registerCodeServerHandlers();
  registerBrowserAutomationIpc();

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await createWindow({
      pendingOpenProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The first window of the session restores and persists saved geometry.
  await createWindow({ pendingOpenProjectPath, restoreWindowState: true });
  pendingOpenProjectPath = null;

  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  resolveBootstrapComplete();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow({ restoreWindowState: true });
    }
  });
}

void runDesktopStartup({
  hasPendingOpenProjectPath: Boolean(pendingOpenProjectPath),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
  autoUpdateInstalledSkills: () => {
    void autoUpdateInstalledSkills().catch((error) => {
      log.error("[skills] auto-update failed", error);
    });
  },
}).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:quitting", {});
  }
}

const quitLifecycle = createQuitLifecycle({
  app,
  closeTransportSessions: closeAllTransportSessions,
  stopDesktopManagedDaemonIfNeeded: () =>
    stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: getDesktopSettingsStore(),
      isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
      stopDaemon: () => stopDesktopDaemonViaCli("quit"),
      showShutdownFeedback: showDaemonShutdownDialog,
    }),
  installAppUpdateOnQuit: async (signal) => {
    const settings = await getDesktopSettingsStore().get();
    return installAppUpdateOnQuit({
      currentVersion: app.getVersion(),
      releaseChannel: settings.releaseChannel,
      signal,
    });
  },
  createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
  onStopError: (error) => {
    log.error("[desktop daemon] failed to stop managed daemon on quit", error);
  },
  onUpdateError: (error) => {
    log.error("[auto-updater] failed to validate downloaded update on quit", error);
  },
});

// electron-updater forwards this event through Electron's built-in autoUpdater.
electronAutoUpdater.on("before-quit-for-update", quitLifecycle.handleBeforeQuitForUpdate);
app.on("before-quit", quitLifecycle.handleBeforeQuit);

// Do not leak the machine-global `code serve-web` we may have spawned.
app.on("will-quit", () => {
  shutdownCodeServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
