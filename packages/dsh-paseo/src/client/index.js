/**
 * dsh-paseo Desktop embed client.
 *
 * Query contract (set by Paseo Desktop when opening a DSH tab):
 *   ?paseoEmbed=1&workspaceId=<id>  → hide sidebar, create a new session, open it
 *   ?paseoEmbed=1&sessionId=<id>    → hide sidebar, open that session
 *
 * Non-embed loads are a no-op so normal `dsh web` keeps full chrome.
 */
window.__ModuleLoader__.load({
  id: "dsh-paseo",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const inject = ["sessions", "workspaces", "layout"];

    function parseEmbedQuery() {
      if (typeof location === "undefined") {
        return { embed: false, workspaceId: null, sessionId: null };
      }
      const query = new URLSearchParams(location.search);
      return {
        embed: query.get("paseoEmbed") === "1",
        workspaceId: (query.get("workspaceId") ?? "").trim() || null,
        sessionId: (query.get("sessionId") ?? "").trim() || null,
      };
    }

    function installEmbedChrome() {
      document.documentElement.dataset.paseoEmbed = "1";
      const style = document.createElement("style");
      style.setAttribute("data-paseo-embed-style", "1");
      // Collapse chrome via grid track sizes only. Do NOT `display:none` the
      // sidebar/details columns — that removes them from the grid so the
      // center column falls into the first (0px) track and the UI goes blank.
      style.textContent = `
html[data-paseo-embed] [class*="_frame"] {
  grid-template-columns: 0px minmax(0, 1fr) 0px !important;
}
html[data-paseo-embed] [class*="_centerCol"] {
  grid-column: 2 / 3 !important;
}
html[data-paseo-embed] [class*="_sidebarCol"],
html[data-paseo-embed] [class*="_detailsCol"] {
  visibility: hidden !important;
  pointer-events: none !important;
  overflow: hidden !important;
}
html[data-paseo-embed] [class*="_handle"] {
  display: none !important;
}
`;
      document.head.appendChild(style);
      return () => {
        style.remove();
        delete document.documentElement.dataset.paseoEmbed;
      };
    }

    function forceSidebarClosed(layout) {
      try {
        layout?.closeDetails?.();
      } catch {
        // layout may not be wired yet
      }
      try {
        // toggleSidebar flips 0 ⟷ default; prefer CSS above. Best-effort close:
        const frame = document.querySelector("[class*='_frame']");
        if (frame && !frame.hasAttribute("data-sidebar-collapsed")) {
          layout?.toggleSidebar?.();
        }
      } catch {
        // ignore
      }
    }

    function waitWorkspaceBaseline(workspaces, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            unsubscribe?.();
          } catch {
            // ignore
          }
          if (error) reject(error);
          else resolve(value);
        };
        const check = () => {
          const snapshot = workspaces?.list?.getSnapshot?.();
          if (snapshot?.baselinesReady) {
            finish(null, snapshot);
          }
        };
        const unsubscribe = workspaces?.list?.subscribe?.(check);
        const timer = setTimeout(() => {
          finish(new Error("dsh-paseo embed: workspace baseline timed out"));
        }, timeoutMs);
        check();
      });
    }

    async function apply(ctx) {
      const { embed, workspaceId, sessionId } = parseEmbedQuery();
      if (!embed) {
        return () => {};
      }

      const removeChrome = installEmbedChrome();
      forceSidebarClosed(ctx.layout);

      let cancelled = false;
      const run = async () => {
        try {
          if (sessionId) {
            ctx.sessions.open(sessionId);
            forceSidebarClosed(ctx.layout);
            return;
          }
          if (!workspaceId) {
            console.warn("dsh-paseo embed: missing workspaceId and sessionId");
            return;
          }
          await waitWorkspaceBaseline(ctx.workspaces);
          if (cancelled) return;
          const createdId = await ctx.sessions.create({ workspaceId });
          if (cancelled) return;
          ctx.sessions.open(createdId);
          forceSidebarClosed(ctx.layout);
        } catch (error) {
          console.warn("dsh-paseo embed: failed to open session", error);
        }
      };
      void run();

      return () => {
        cancelled = true;
        removeChrome();
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
