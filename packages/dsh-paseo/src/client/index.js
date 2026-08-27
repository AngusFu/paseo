/**
 * dsh-paseo Desktop embed client.
 *
 * Query contract (set by Paseo Desktop / deep links):
 *   ?paseoEmbed=1&sessionId=<id>     → open that session (preferred; pin on reload)
 *   ?paseoEmbed=1&workspaceId=<id>   → create a new session, open it, rewrite URL
 *   &permission=<preset>             → /permission <preset> after open
 *                                      (read-only | workspace-write | danger-full-access)
 *   &agentPreset=<id>                → passed through URL for create path / documentation
 *   &sidebar=collapsed|hidden|open   → default collapsed (toggleable); hidden = no column
 *
 * Non-embed loads are a no-op so normal `dsh web` keeps full chrome.
 */
window.__ModuleLoader__.load({
  id: "dsh-paseo",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const inject = ["sessions", "workspaces", "layout", "remote"];

    function normalizePermission(raw) {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const lowered = trimmed.toLowerCase().replace(/[_\s]+/g, "-");
      const aliases = {
        readonly: "read-only",
        "read-only": "read-only",
        read: "read-only",
        "workspace-write": "workspace-write",
        workspacewrite: "workspace-write",
        write: "workspace-write",
        "danger-full-access": "danger-full-access",
        dangerfullaccess: "danger-full-access",
        full: "danger-full-access",
        yolo: "danger-full-access",
      };
      return aliases[lowered] ?? trimmed;
    }

    function parseEmbedQuery() {
      if (typeof location === "undefined") {
        return {
          embed: false,
          workspaceId: null,
          sessionId: null,
          permission: null,
          agentPreset: null,
          sidebar: "collapsed",
        };
      }
      const query = new URLSearchParams(location.search);
      const sidebarRaw = (query.get("sidebar") ?? "collapsed").trim().toLowerCase();
      const sidebar =
        sidebarRaw === "hidden" || sidebarRaw === "open" || sidebarRaw === "collapsed"
          ? sidebarRaw
          : "collapsed";
      return {
        embed: query.get("paseoEmbed") === "1",
        workspaceId: (query.get("workspaceId") ?? "").trim() || null,
        sessionId: (query.get("sessionId") ?? "").trim() || null,
        permission: normalizePermission(query.get("permission")),
        agentPreset: (query.get("agentPreset") ?? "").trim() || null,
        sidebar,
      };
    }

    function pinSessionInUrl(sessionId, extras = {}) {
      try {
        if (typeof location === "undefined" || typeof history === "undefined") {
          return;
        }
        const url = new URL(location.href);
        url.searchParams.set("paseoEmbed", "1");
        url.searchParams.set("sessionId", sessionId);
        url.searchParams.delete("workspaceId");
        if (extras.permission) {
          url.searchParams.set("permission", extras.permission);
        }
        if (extras.agentPreset) {
          url.searchParams.set("agentPreset", extras.agentPreset);
        }
        if (extras.sidebar) {
          url.searchParams.set("sidebar", extras.sidebar);
        }
        history.replaceState(history.state, "", url.toString());
      } catch {
        // ignore — pin is best-effort
      }
    }

    function installEmbedChrome(sidebarMode) {
      document.documentElement.dataset.paseoEmbed = "1";
      document.documentElement.dataset.paseoSidebar = sidebarMode;
      const style = document.createElement("style");
      style.setAttribute("data-paseo-embed-style", "1");
      // Default (`collapsed`): do NOT remove sidebar from the grid — DSH keeps a
      // compact rail and layout.toggleSidebar can expand it. Only `hidden` forces
      // zero tracks (legacy hard-hide). Never display:none the columns alone —
      // that used to park the center column in a 0px track (blank UI).
      style.textContent =
        sidebarMode === "hidden"
          ? `
html[data-paseo-embed][data-paseo-sidebar="hidden"] [class*="_frame"] {
  grid-template-columns: 0px minmax(0, 1fr) 0px !important;
}
html[data-paseo-embed][data-paseo-sidebar="hidden"] [class*="_centerCol"] {
  grid-column: 2 / 3 !important;
}
html[data-paseo-embed][data-paseo-sidebar="hidden"] [class*="_sidebarCol"],
html[data-paseo-embed][data-paseo-sidebar="hidden"] [class*="_detailsCol"] {
  visibility: hidden !important;
  pointer-events: none !important;
  overflow: hidden !important;
}
html[data-paseo-embed][data-paseo-sidebar="hidden"] [class*="_handle"] {
  display: none !important;
}
`
          : "";
      document.head.appendChild(style);
      return () => {
        style.remove();
        delete document.documentElement.dataset.paseoEmbed;
        delete document.documentElement.dataset.paseoSidebar;
      };
    }

    function collapseSidebar(layout) {
      try {
        layout?.closeDetails?.();
      } catch {
        // ignore
      }
      try {
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

    async function applyPermission(remote, sessionId, permission) {
      if (!permission || !sessionId) return;
      try {
        const result = await remote?.commands?.execute?.(
          sessionId,
          `/permission ${permission}`,
          [],
        );
        if (result && result.ok === false) {
          console.warn("dsh-paseo embed: permission switch failed", result.error);
        }
      } catch (error) {
        console.warn("dsh-paseo embed: permission switch failed", error);
      }
    }

    async function apply(ctx) {
      const { embed, workspaceId, sessionId, permission, agentPreset, sidebar } = parseEmbedQuery();
      if (!embed) {
        return () => {};
      }

      const removeChrome = installEmbedChrome(sidebar);
      if (sidebar !== "open") {
        collapseSidebar(ctx.layout);
      }

      let cancelled = false;
      const run = async () => {
        try {
          let openId = sessionId;
          if (!openId) {
            if (!workspaceId) {
              console.warn("dsh-paseo embed: missing workspaceId and sessionId");
              return;
            }
            await waitWorkspaceBaseline(ctx.workspaces);
            if (cancelled) return;
            const createPayload = { workspaceId };
            if (agentPreset) {
              createPayload.agentPreset = agentPreset;
            }
            openId = await ctx.sessions.create(createPayload);
            if (cancelled) return;
            pinSessionInUrl(openId, { permission, agentPreset, sidebar });
          }
          ctx.sessions.open(openId);
          if (sidebar !== "open") {
            collapseSidebar(ctx.layout);
          }
          await applyPermission(ctx.remote, openId, permission);
          if (sidebar !== "open") {
            collapseSidebar(ctx.layout);
          }
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
