#!/usr/bin/env -S uv run --script
# Needs `uv` on PATH. Preferred entry: `paseo markdown` (packages/cli wraps this).
# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown>=3.5", "pygments>=2.17", "bleach>=6.1", "pyyaml>=6.0"]
# ///
"""paseo markdown — turn a markdown archive into a styled HTML preview.

Markdown stays the source of truth. HTML is a derived view written under the
system temp dir ($TMPDIR/paseo-markdown/, OS-reclaimable) — never beside the
.md unless --out says so.

  paseo markdown notes.md
  paseo markdown notes.md --no-cache
  paseo markdown notes.md --clear
  paseo markdown --clear-all
  paseo markdown --cache-dir
  paseo markdown --serve

Optional YAML front matter (title/badges/date/template/todos). Features: bleach
sanitize, pygments, TOC + scroll-spy, mermaid fences, reading-time, autolink.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from datetime import date, datetime
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import bleach
import markdown
import yaml
from pygments.formatters import HtmlFormatter

# python-markdown passes raw HTML through. Preview bodies can include pasted
# ticket/MR text, and --serve serves them as same-origin HTML — bleach the
# converted markup before we splice trusted mermaid/front-matter back in.
_HL_TAGS = ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em",
            "del", "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "a", "code",
            "pre", "span", "div", "table", "thead", "tbody", "tr", "th", "td",
            "img", "sup", "sub"]
_HL_ATTRS = {"a": ["href", "title", "id"], "img": ["src", "alt", "title"],
             "span": ["class"], "div": ["class"], "code": ["class"], "pre": ["class"],
             "td": ["align"], "th": ["align"], "h1": ["id"], "h2": ["id"],
             "h3": ["id"], "h4": ["id"], "h5": ["id"], "h6": ["id"], "li": ["id"]}
_HL_PROTOCOLS = ["http", "https", "mailto"]  # no javascript:/data: hrefs


def sanitize(html: str) -> str:
    return bleach.clean(html, tags=_HL_TAGS, attributes=_HL_ATTRS,
                        protocols=_HL_PROTOCOLS, strip=True)


# Autolink after sanitize, before mermaid splice-back.
# PASEO_MARKDOWN_* wins; older REPORT_HTML_*/RENDER_*/LOOP_* names still work.
# COMPAT(reportHtmlEnv): added in v0.1.106, remove after 2027-01-31.
JIRA_BROWSE = (os.environ.get("PASEO_MARKDOWN_JIRA_BROWSE")
               or os.environ.get("REPORT_HTML_JIRA_BROWSE")
               or os.environ.get("RENDER_JIRA_BROWSE")
               or "https://mdpi.atlassian.net/browse/")
GITLAB_WEB = (os.environ.get("PASEO_MARKDOWN_GITLAB_WEB")
              or os.environ.get("REPORT_HTML_GITLAB_WEB")
              or os.environ.get("LOOP_GITLAB_WEB")
              or "https://gitlab.mdpi.com:8081")

# Odd regex segments are tags / existing anchors / code — leave those alone.
_SKIP_RE = re.compile(r"(<a\b.*?</a\s*>|<code\b.*?</code\s*>|<pre\b.*?</pre\s*>|<[^>]+>)",
                      re.DOTALL | re.IGNORECASE)

# Single pass: first match wins. Avoid bleach.linkify — it re-escapes entities
# inside skipped tags and turns pygments `-&gt;` into a literal `-&gt;` display.
_TOKEN_RE = re.compile(
    r"(?P<url>(?:https?://|www\.)[^\s<>\"']+)"
    r"|(?P<scif>\bSCIF-\d+\b)"
    r"|(?P<mr>(?<![\w!])!(?P<iid>\d{2,6})\b)")
_URL_TRAIL = ".,;:!?)]}'\"«»“”‘’"   # sentence punctuation that abuts a url, not part of it


@lru_cache(maxsize=64)
def _mr_base(md_path: Path) -> str | None:
    # Derive GitLab MR base from the nearest git remote (cached for --serve).
    root = next((p for p in md_path.resolve().parents if (p / ".git").exists()), None)
    if root is None:
        return None
    r = subprocess.run(["git", "-C", str(root), "remote", "get-url", "origin"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    url = r.stdout.strip()
    if "://" in url:                      # ssh://git@host:9922/group/proj.git
        rest = url.split("://", 1)[1]
        path = rest.split("/", 1)[1] if "/" in rest else ""
    elif ":" in url:                      # git@host:group/proj.git
        path = url.split(":", 1)[1]
    else:
        return None
    path = path.strip("/").removesuffix(".git")
    return f"{GITLAB_WEB}/{path}/-/merge_requests/" if path else None


def autolink(html: str, mr_base: str | None) -> str:
    def one(m: re.Match[str]) -> str:
        if url := m.group("url"):
            trail = ""
            while url and url[-1] in _URL_TRAIL:
                url, trail = url[:-1], url[-1] + trail
            if not url:
                return m.group(0)
            href = url if url.startswith("http") else f"https://{url}"
            return f'<a href="{href}">{url}</a>{trail}'
        if key := m.group("scif"):
            return f'<a href="{JIRA_BROWSE}{key}">{key}</a>'
        if mr_base and (iid := m.group("iid")):
            return f'<a href="{mr_base}{iid}">!{iid}</a>'
        return m.group(0)   # !iid with no origin -> leave as plain text

    parts = _SKIP_RE.split(html)
    return "".join(p if i % 2 else _TOKEN_RE.sub(one, p) for i, p in enumerate(parts))


HERE = Path(__file__).resolve().parent
TEMPLATE = (HERE / "templates" / "base.html").read_text()

# Preview dir under the OS temp tree so reboots / tmp GC can reclaim it.
# Override with PASEO_MARKDOWN_CACHE if you need a sticky location.
CACHE_DIR = Path(os.environ.get("PASEO_MARKDOWN_CACHE")
                 or os.environ.get("REPORT_HTML_CACHE")  # COMPAT(reportHtmlEnv)
                 or (Path(tempfile.gettempdir()) / "paseo-markdown"))

DEFAULT_PORT = int(os.environ.get("PASEO_MARKDOWN_PORT")
                   or os.environ.get("REPORT_HTML_PORT")  # COMPAT(reportHtmlEnv)
                   or "4490")

FRAME_ANCESTORS = (os.environ.get("PASEO_MARKDOWN_FRAME_ANCESTORS")
                   or os.environ.get("REPORT_HTML_FRAME_ANCESTORS")  # COMPAT(reportHtmlEnv)
                   or "'none'")
SERVE_CSP = f"frame-ancestors {FRAME_ANCESTORS}"

# Accent pair = light-bg / dark-bg. Path segments can auto-pick a theme.
THEMES: dict[str, dict[str, str]] = {
    "generic": {"accent": "#2f6df6", "accent_dark": "#5b8dff", "label": "report"},
    "kb-audit": {"accent": "#1f8a4c", "accent_dark": "#4cc37e", "label": "kb audit"},
    "mr-review": {"accent": "#cf5316", "accent_dark": "#fc6d26", "label": "mr review"},
    "plan": {"accent": "#7048e8", "accent_dark": "#a78bfa", "label": "plan"},
}
AUTO_RULES: list[tuple[str, str]] = [
    ("agent-knowledge-maintenance", "kb-audit"),
    ("context-audit", "kb-audit"),
    ("reviews", "mr-review"),
    ("plans", "plan"),
    ("agent-self-improvement", "generic"),
]

MERMAID_RE = re.compile(r"^```mermaid[ \t]*\n(.*?)^```[ \t]*$\n?", re.DOTALL | re.MULTILINE)
MERMAID_JS = """<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
// manual data-theme (toggle button) wins over the system preference
const forced = document.documentElement.dataset.theme;
mermaid.initialize({ startOnLoad: true,
  theme: (forced ? forced === "dark"
                 : matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark" : "default" });
</script>"""


def pick_template(md_path: Path, requested: str) -> str:
    if requested != "auto":
        return requested if requested in THEMES else "generic"
    parts = {p.lower() for p in md_path.parts}
    for seg, theme in AUTO_RULES:
        if seg in parts:
            return theme
    return "generic"


# Keys consumed by the header/theme path — not repeated in the meta card.
# `todos` is rendered as its own checklist section.
_FM_RESERVED = frozenset({"title", "name", "badges", "date", "template", "todos"})


def _meta_get(meta: dict[str, Any], key: str, default: Any = None) -> Any:
    """Case-insensitive key lookup (YAML keeps original casing; flat fallback lowercases)."""
    if key in meta:
        return meta[key]
    lk = key.lower()
    for k, v in meta.items():
        if str(k).lower() == lk:
            return v
    return default


def _meta_str(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (date, datetime)):
        return val.isoformat()
    return str(val).strip()


# Skip leading HTML comments (Cursor plan ids) so the YAML fence still matches.
_FM_LEAD_RE = re.compile(r"\A(?:\s*<!--.*?-->)*\s*", re.DOTALL)
_FM_BLOCK_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def split_front_matter(text: str) -> tuple[dict[str, Any], str]:
    # optional leading --- block. Prefer real YAML (nested todos, folded scalars);
    # fall back to flat key: value so a broken block still strips cleanly.
    lead = _FM_LEAD_RE.match(text)
    rest = text[lead.end():] if lead else text
    m = _FM_BLOCK_RE.match(rest)
    if not m:
        return {}, text
    raw = m.group(1)
    # drop the Cursor plan-id comment with the fence; body starts after ---
    body = rest[m.end():]
    try:
        loaded = yaml.safe_load(raw)
        if isinstance(loaded, dict):
            return {str(k): v for k, v in loaded.items()}, body
        if loaded is None:
            return {}, body
    except yaml.YAMLError:
        pass
    meta: dict[str, Any] = {}
    for line in raw.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip().lower()] = v.strip()
    return meta, body


def extract_title(meta: dict[str, Any], body: str, md_path: Path) -> tuple[str, str]:
    # title = front-matter title > name > first H1 (removed from body) > filename
    for key in ("title", "name"):
        t = _meta_str(_meta_get(meta, key))
        if t:
            return t, body
    m = re.search(r"^# (.+)$", body, re.MULTILINE)
    if m:
        return m.group(1).strip(), body.replace(m.group(0), "", 1)
    return md_path.stem, body


def esc(s: str) -> str:
    # Escape text used in both body and attribute slots.
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def _fmt_meta_value(val: Any) -> str:
    """Scalar → escaped text; nested structure → escaped YAML block."""
    if isinstance(val, (dict, list)):
        dumped = yaml.safe_dump(val, allow_unicode=True, default_flow_style=False).rstrip()
        return f'<pre class="fm-yaml">{esc(dumped)}</pre>'
    return esc(_meta_str(val))


_TODO_STATUS_MARK = {
    "completed": ("✓", "done"),
    "done": ("✓", "done"),
    "in_progress": ("◐", "doing"),
    "in-progress": ("◐", "doing"),
    "cancelled": ("✕", "cancelled"),
    "canceled": ("✕", "cancelled"),
    "pending": ("○", "pending"),
}


def render_todos_html(todos: Any) -> str:
    """Cursor/plan-style todos list → checklist. Non-list → empty."""
    if not isinstance(todos, list) or not todos:
        return ""
    items: list[str] = []
    for t in todos:
        if isinstance(t, str):
            content, status, tid = t, "pending", ""
        elif isinstance(t, dict):
            content = _meta_str(t.get("content") or t.get("title") or t.get("text") or "")
            status = _meta_str(t.get("status") or "pending").lower() or "pending"
            tid = _meta_str(t.get("id") or "")
            if not content:
                content = tid or _meta_str(t)
        else:
            content, status, tid = _meta_str(t), "pending", ""
        if not content:
            continue
        mark, cls = _TODO_STATUS_MARK.get(status, ("○", "pending"))
        id_html = f' <code class="todo-id">{esc(tid)}</code>' if tid else ""
        items.append(
            f'<li class="todo todo-{cls}" data-status="{esc(status)}">'
            f'<span class="todo-mark" aria-hidden="true">{mark}</span>'
            f'<span class="todo-content">{esc(content)}</span>{id_html}</li>')
    if not items:
        return ""
    return ('<section class="fm-todos" aria-label="todos">\n'
            '<h2 class="fm-heading">Todos</h2>\n'
            f'<ul class="todo-list">\n{"".join(items)}\n</ul>\n</section>\n')


def render_meta_html(meta: dict[str, Any]) -> str:
    """Leftover front-matter keys (not title/badges/date/template/todos) → dl card."""
    rows: list[str] = []
    for k, v in meta.items():
        if str(k).lower() in _FM_RESERVED:
            continue
        if v is None or v == "":
            continue
        rows.append(f"<div><dt>{esc(str(k))}</dt><dd>{_fmt_meta_value(v)}</dd></div>")
    if not rows:
        return ""
    return ('<section class="fm-meta" aria-label="front matter">\n'
            '<h2 class="fm-heading">Meta</h2>\n'
            f'<dl class="fm-dl">\n{"".join(rows)}\n</dl>\n</section>\n')


def render_front_matter_html(meta: dict[str, Any]) -> str:
    # trusted markup built with esc(); splice in AFTER sanitize (like mermaid).
    if not meta:
        return ""
    return render_meta_html(meta) + render_todos_html(_meta_get(meta, "todos"))


def pull_mermaid(body: str) -> tuple[str, list[str]]:
    # Pull mermaid fences out before markdown convert; splice back afterward.
    blocks: list[str] = []

    def grab(m: re.Match[str]) -> str:
        blocks.append(m.group(1))
        return f"\n@@MERMAID{len(blocks) - 1}@@\n"

    return MERMAID_RE.sub(grab, body), blocks


def put_mermaid(html: str, blocks: list[str]) -> str:
    for i, code in enumerate(blocks):
        pre = f'<pre class="mermaid">{esc(code)}</pre>'
        token = f"@@MERMAID{i}@@"
        html = html.replace(f"<p>{token}</p>", pre).replace(token, pre)
    return html


def wrap_tables(html: str) -> str:
    # Wide tables scroll inside .table-scroll panels (post-sanitize).
    return (re.sub(r"<table\b", '<div class="table-scroll"><table', html)
            .replace("</table>", "</table></div>"))


def reading_time(text: str) -> int:
    # zh chars + latin words, mixed-doc friendly. floor 1 min.
    cjk = len(re.findall(r"[一-鿿]", text))
    words = len(re.findall(r"[A-Za-z0-9_]+", text))
    return max(1, round(cjk / 400 + words / 230))


@lru_cache(maxsize=1)
def highlight_css() -> str:
    # Offline pygments CSS for light / prefers-color-scheme dark / forced dark.
    fmt_dark = HtmlFormatter(style="github-dark")
    light = HtmlFormatter(style="default").get_style_defs(".hl")
    dark_auto = fmt_dark.get_style_defs(':root:not([data-theme="light"]) .hl')
    dark_forced = fmt_dark.get_style_defs(':root[data-theme="dark"] .hl')
    return (f"{light}\n"
            f"@media (prefers-color-scheme: dark) {{\n{dark_auto}\n}}\n"
            f"{dark_forced}")


def render(md_path: Path, template: str, backlink: str = "", img_base: str = "") -> str:
    meta, body = split_front_matter(md_path.read_text())
    theme_raw = _meta_get(meta, "template", template)
    theme_name = theme_raw if isinstance(theme_raw, str) else template
    theme = THEMES.get(theme_name, THEMES["generic"])
    title, body = extract_title(meta, body, md_path)
    # name used as title fallback → omit from meta card (avoid duplicating the h1)
    if not _meta_str(_meta_get(meta, "title")) and _meta_str(_meta_get(meta, "name")):
        meta = {k: v for k, v in meta.items() if str(k).lower() != "name"}
    body, mermaid_blocks = pull_mermaid(body)

    md = markdown.Markdown(
        extensions=["extra", "toc", "sane_lists", "admonition", "codehilite"],
        extension_configs={"toc": {"toc_depth": "2-3"},
                           "codehilite": {"css_class": "hl", "guess_lang": False}})
    # sanitize the markdown-rendered HTML, autolink text nodes, wrap tables, THEN
    # splice trusted mermaid <pre> + front-matter panels back in
    html_body = put_mermaid(
        wrap_tables(autolink(sanitize(md.convert(body)), _mr_base(md_path))),
        mermaid_blocks)
    fm_html = render_front_matter_html(meta)
    if fm_html:
        html_body = fm_html + html_body
    if img_base:
        html_body = rebase_images(html_body, img_base)
    toc = getattr(md, "toc", "") or ""
    if "<li>" not in toc:
        toc = ""  # flat doc, no nav worth showing

    when_raw = _meta_get(meta, "date")
    when = (_meta_str(when_raw)
            or date.fromtimestamp(md_path.stat().st_mtime).isoformat())
    badges = [f'<span class="badge">{esc(when)}</span>']
    badges.append(f'<span class="badge">约 {reading_time(body)} 分钟</span>')
    raw_badges = _meta_get(meta, "badges", "")
    if isinstance(raw_badges, list):
        badge_items = [_meta_str(x) for x in raw_badges if _meta_str(x)]
    else:
        badge_items = [x.strip() for x in str(raw_badges or "").split(",") if x.strip()]
    for b in badge_items:
        badges.append(f'<span class="badge">{esc(b)}</span>')

    out = TEMPLATE
    for slot, val in {
        "title": esc(title), "badges": "\n    ".join(badges), "toc": toc,
        "eyebrow": esc(theme["label"]),
        "body": html_body, "accent": theme["accent"],
        "accent_dark": theme["accent_dark"],
        "source": esc(str(md_path)),
        "backlink": f'<a class="back" href="{esc(backlink)}">← 返回</a>' if backlink else "",
        "layout_class": "with-toc" if toc else "no-toc",
        "highlight_css": highlight_css(),
        "extra_scripts": MERMAID_JS if mermaid_blocks else "",
    }.items():
        out = out.replace("{{" + slot + "}}", val)
    return out


# ---------- shared path validation (CLI + serve) ----------
MD_SUFFIXES = (".md", ".markdown")


class BadMd(ValueError):
    """Rejected md path. .code = http status serve should answer with."""

    def __init__(self, msg: str, code: int = 400) -> None:
        super().__init__(msg)
        self.code = code


def _serve_roots() -> list[Path]:
    """Paths --serve may read. Default: launch CWD + cache dir. Override with
    PASEO_MARKDOWN_ROOTS (os.pathsep-separated). CLI render stays unconfined."""
    env = (os.environ.get("PASEO_MARKDOWN_ROOTS")
           or os.environ.get("REPORT_HTML_ROOTS", ""))  # COMPAT(reportHtmlEnv)
    if env.strip():
        return [Path(os.path.expanduser(p)).resolve()
                for p in env.split(os.pathsep) if p.strip()]
    return [Path.cwd().resolve(), CACHE_DIR.resolve()]


def resolve_md(raw: str, roots: list[Path] | None = None) -> Path:
    """Resolve a markdown path. Serve mode passes `roots` as an allowlist."""
    if not raw:
        raise BadMd("no path given")
    p = Path(os.path.expanduser(raw)).resolve()
    if p.suffix.lower() not in MD_SUFFIXES:
        raise BadMd(f"not a markdown file: {p}", 415)
    if roots is not None and not any(p == r or p.is_relative_to(r) for r in roots):
        raise BadMd(f"path outside the allowed roots: {p}", 403)
    if not p.is_file():
        raise BadMd(f"no such file: {p}", 404)
    return p


# Rebase relative <img src> when the page is served from another origin/path.
_IMG_SRC_RE = re.compile(r'(<img\b[^>]*?\bsrc=")([^"]*)(")', re.IGNORECASE)
_ABS_SRC_RE = re.compile(r"[a-z][a-z0-9+.-]*:|/|#|@@", re.IGNORECASE)


def rebase_images(html: str, base: str) -> str:
    safe_base = esc(base)

    def one(m: re.Match[str]) -> str:
        src = m.group(2)
        if not src or _ABS_SRC_RE.match(src):
            return m.group(0)
        return f"{m.group(1)}{safe_base}{src}{m.group(3)}"

    return _IMG_SRC_RE.sub(one, html)


def render_path(raw: str, template: str = "auto", backlink: str = "",
                img_base: str = "", roots: list[Path] | None = None) -> str:
    md = resolve_md(raw, roots)
    return render(md, pick_template(md, template), backlink, img_base)


# ---------- serve mode ----------
USAGE_HTML = """<!doctype html><meta charset=utf-8><title>paseo markdown</title>
<style>body{font:15px/1.6 -apple-system,sans-serif;max-width:640px;margin:60px auto;
padding:0 20px;background:#0f1117;color:#d8dce6}code{background:#232838;padding:2px 6px;
border-radius:5px}a{color:#5b9dff}@media(prefers-color-scheme:light){body{background:#fff;
color:#1f2430}code{background:#eef1f6}}</style>
<h1>paseo markdown <small>serve</small></h1>
<p>Render any markdown file on demand:</p>
<ul>
<li><code>GET /?path=/abs/path/to/report.md</code></li>
<li><code>GET /render/&lt;urlencoded abs path&gt;</code></li>
<li><code>GET /healthz</code></li>
</ul>
<p>Localhost only. Output matches <code>paseo markdown &lt;file.md&gt; --stdout</code>.</p>
"""

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


class Handler(BaseHTTPRequestHandler):
    server_version = "paseo-markdown"

    def _send(self, code: int, body: str, ctype: str = "text/html; charset=utf-8") -> None:
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", SERVE_CSP)
        self.end_headers()
        self.wfile.write(raw)

    def _host_ok(self) -> bool:
        # Bound to 127.0.0.1; still reject non-loopback Host (DNS rebinding).
        host = self.headers.get("Host", "")
        return host.rsplit(":", 1)[0].strip("[]") in {h.strip("[]") for h in _LOCAL_HOSTS}

    def do_GET(self) -> None:  # noqa: N802 - stdlib http.server API
        if not self._host_ok():
            self._send(421, "bad host", "text/plain; charset=utf-8")
            return
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/healthz":
            self._send(200, "ok", "text/plain; charset=utf-8")
            return
        q = urllib.parse.parse_qs(u.query)
        raw = ""
        if u.path == "/":
            raw = q.get("path", [""])[0]
            if not raw:
                self._send(200, USAGE_HTML)
                return
        elif u.path.startswith("/render/"):
            raw = urllib.parse.unquote(u.path[len("/render/"):])
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")
            return
        # Optional ?base= rebases relative <img src> onto the caller's asset URL.
        img_base = q.get("base", [""])[0]
        try:
            self._send(200, render_path(raw, img_base=img_base, roots=_serve_roots()))
        except BadMd as e:
            self._send(e.code, str(e), "text/plain; charset=utf-8")
        except UnicodeDecodeError:
            self._send(415, "not valid UTF-8 markdown", "text/plain; charset=utf-8")
        except OSError as e:
            self._send(500, f"render failed: {e}", "text/plain; charset=utf-8")

    def log_message(self, fmt: str, *a: object) -> None:
        sys.stderr.write(f"{self.address_string()} {fmt % a}\n")


def serve(port: int) -> None:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"paseo markdown serving on http://127.0.0.1:{port}  (ctrl-c to stop)",
          file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


# ---------- cli mode ----------
def _opener() -> str:
    return "open" if sys.platform == "darwin" else "xdg-open"


def open_in_viewer(path: Path) -> None:
    url = path.resolve().as_uri()
    subprocess.run([_opener(), url], capture_output=True)


def cache_path(md: Path) -> Path:
    # One stable file per absolute source path (stem + path hash).
    digest = hashlib.sha1(str(md.resolve()).encode()).hexdigest()[:10]
    return CACHE_DIR / f"{md.stem}-{digest}.html"


def ephemeral_path(md: Path) -> Path:
    """Temp HTML for --no-cache (not under CACHE_DIR, not beside the .md)."""
    fd, name = tempfile.mkstemp(prefix=f"{md.stem}-", suffix=".html")
    os.close(fd)
    return Path(name)


def clear_cache_entry(md: Path) -> Path | None:
    target = cache_path(md)
    if target.is_file():
        target.unlink()
        return target
    return None


def clear_all_cache() -> list[Path]:
    if not CACHE_DIR.is_dir():
        return []
    removed: list[Path] = []
    for path in sorted(CACHE_DIR.glob("*.html")):
        path.unlink()
        removed.append(path)
    return removed


def list_cache() -> list[Path]:
    if not CACHE_DIR.is_dir():
        return []
    return sorted(CACHE_DIR.glob("*.html"))


def main() -> None:
    ap = argparse.ArgumentParser(prog="paseo markdown", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    _ = ap.add_argument("md", nargs="?", type=str, help="markdown file to render")
    _ = ap.add_argument("--template", default="auto", choices=["auto", *THEMES])
    _ = ap.add_argument("--out", type=Path, default=None, help="write html here")
    _ = ap.add_argument("--stdout", action="store_true", help="html to stdout")
    _ = ap.add_argument("--print", dest="print_only", action="store_true",
                        help="print output path only, do not open")
    _ = ap.add_argument("--backlink", default="", help="header back-link URL")
    _ = ap.add_argument("--no-cache", action="store_true",
                        help="write a temp html instead of the stable cache file")
    _ = ap.add_argument("--clear", action="store_true",
                        help="delete the cache entry for <md> and exit")
    _ = ap.add_argument("--clear-all", action="store_true",
                        help="delete every cached html under the cache dir")
    _ = ap.add_argument("--cache-dir", action="store_true",
                        help="print the cache directory and exit")
    _ = ap.add_argument("--ls-cache", action="store_true",
                        help="list cached html files and exit")
    _ = ap.add_argument("--serve", action="store_true", help="run the render server")
    _ = ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args()

    if args.cache_dir:
        print(CACHE_DIR)
        return
    if args.ls_cache:
        for path in list_cache():
            print(path)
        return
    if args.clear_all:
        removed = clear_all_cache()
        print(f"cleared {len(removed)} file(s) from {CACHE_DIR}")
        return
    if args.serve:
        serve(args.port)
        return
    if args.clear:
        if not args.md:
            ap.error("--clear needs a markdown path (or use --clear-all)")
        try:
            md = resolve_md(args.md)
        except BadMd as e:
            sys.exit(str(e))
        removed = clear_cache_entry(md)
        if removed:
            print(f"cleared {removed}")
        else:
            print(f"no cache entry for {md}")
        return
    if not args.md or args.md == "help":
        ap.print_help()
        return

    try:
        md = resolve_md(args.md)
    except BadMd as e:
        sys.exit(str(e))

    html = render(md, pick_template(md, args.template), args.backlink)
    if args.stdout:
        sys.stdout.write(html)
        return

    if args.out is not None:
        out = args.out
    elif args.no_cache:
        out = ephemeral_path(md)
    else:
        out = cache_path(md)
    out.parent.mkdir(parents=True, exist_ok=True)
    _ = out.write_text(html)
    print(out)
    if not args.print_only:
        open_in_viewer(out)


if __name__ == "__main__":
    main()
