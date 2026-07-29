import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from "electron";
import {
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
} from "./browser-webviews/window-open.js";
import { registerBrowserWebviewNavigationGuards } from "./browser-webviews/index.js";

export const PASEO_CODE_SERVER_PARTITION = "persist:paseo-code-server";

const CODE_SERVER_WINDOW_WIDTH = 1280;
const CODE_SERVER_WINDOW_HEIGHT = 840;

const windowsByUrl = new Map<string, BrowserWindow>();

export function workspaceBasename(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? cwd;
}

function resolveWindowIconPath(): string | null {
  const candidate = path.resolve(__dirname, "../assets/icon.png");
  return existsSync(candidate) ? candidate : null;
}

function getCodeServerPopupWindowOptions(): BrowserWindowConstructorOptions {
  const iconPath = resolveWindowIconPath();
  return {
    show: true,
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      partition: PASEO_CODE_SERVER_PARTITION,
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

function installCodeServerWindowOpenHandler(contents: WebContents): void {
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
        overrideBrowserWindowOptions: getCodeServerPopupWindowOptions(),
      };
    }

    void contents.loadURL(decision.url);
    return { action: "deny" };
  });

  contents.on("did-create-window", (popupWindow) => {
    const popupContents = popupWindow.webContents;
    registerBrowserWebviewNavigationGuards(popupContents);
    installCodeServerWindowOpenHandler(popupContents);
  });
}

export function parseCodeServerOpenWindowInput(raw: unknown): { url: string; cwd: string } {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid code-server window input");
  }
  const input = raw as { url?: unknown; cwd?: unknown };
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!url || !cwd || !isAllowedBrowserWebviewUrl(url)) {
    throw new Error("Invalid code-server window input");
  }
  return { url, cwd };
}

export function openCodeServerWindow(input: { url: string; cwd: string }): void {
  const parsed = parseCodeServerOpenWindowInput(input);
  const existing = windowsByUrl.get(parsed.url);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
    return;
  }

  const iconPath = resolveWindowIconPath();
  const window = new BrowserWindow({
    title: `VS Code Web — ${workspaceBasename(parsed.cwd)}`,
    width: CODE_SERVER_WINDOW_WIDTH,
    height: CODE_SERVER_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      partition: PASEO_CODE_SERVER_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  windowsByUrl.set(parsed.url, window);
  window.on("closed", () => {
    if (windowsByUrl.get(parsed.url) === window) {
      windowsByUrl.delete(parsed.url);
    }
  });

  const { webContents } = window;
  registerBrowserWebviewNavigationGuards(webContents);
  installCodeServerWindowOpenHandler(webContents);

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  void webContents.loadURL(parsed.url).catch(() => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });
}

export function closeAllCodeServerWindows(): void {
  for (const window of windowsByUrl.values()) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  windowsByUrl.clear();
}

export function listCodeServerWindowsForTests(): BrowserWindow[] {
  return [...windowsByUrl.values()];
}

export function resetCodeServerWindowsForTests(): void {
  windowsByUrl.clear();
}
