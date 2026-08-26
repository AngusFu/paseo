# DeepSeek Harness (Desktop)

Desktop-managed integration for the DeepSeek Harness (`@deepseek-ai/dsh`) Web UI.

## Ownership

- Process lifecycle lives in **Electron main** (`packages/desktop/src/features/deepseek-harness/`), same shape as code-server: install / start / stop / quit cleanup.
- Not a daemon/host feature — no `server_info.features` gate. Mobile and plain browser clients do not expose the UI.
- Node runtime for install + `dsh web` is Electron’s own binary via `ELECTRON_RUN_AS_NODE=1`.

## Settings

Desktop-only Settings section `deepseek-harness`:

- Install / Upgrade (`npm install @deepseek-ai/dsh@latest --prefix <userData>/toolchains/deepseek-harness`)
- Start / Stop
- **Start with Desktop** (`desktop-settings.deepseekHarness.startWithDesktop`)
- Persisted listen port (`deepseekHarness.port`); first start allocates a free loopback port and keeps it

## Workspace UI

- New tab kind `deepseek_harness` (Electron `<webview>` via `BrowserPane`)
- Header menu + tab `+` menu: **DeepSeek Harness**
- Opening ensures the process is running, then calls DSH `workspace.create` / `workspace.list` (same envelope as `tools/dsh-paseo`) so the current Paseo workspace cwd is registered, then loads the Web UI URL

## IPC

`paseo:deepseek-harness:{getStatus,install,start,stop,openWorkspace}` exposed on `window.paseoDesktop.deepseekHarness`.
