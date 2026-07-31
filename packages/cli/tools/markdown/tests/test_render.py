"""paseo markdown unit tests — pure-function md->html pipeline pieces, no browser, no net.

    cd packages/cli/tools/markdown && make test   # via uv (deps auto-fetched)
    python3 -m unittest discover                  # if markdown/pygments/bleach importable
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("render", HERE.parent / "render.py")
assert _spec and _spec.loader
render = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(render)

MR = "https://gitlab.mdpi.com:8081/g/p/-/merge_requests/"


def _md(text: str) -> Path:
    """Write md into a fresh temp dir (no .git ancestor -> _mr_base short-circuits
    to None, so render() never forks git in tests)."""
    d = Path(tempfile.mkdtemp())
    p = d / "r.md"
    _ = p.write_text(text)
    return p


class TestSanitize(unittest.TestCase):
    """The CRITICAL guard: report bodies embed attacker-writable jira/MR content and
    --serve hands them to a browser as same-origin text/html."""

    def s(self, h: str) -> str:
        return render.sanitize(h)

    def test_strips_script(self):
        self.assertNotIn("<script>", self.s("<script>alert(1)</script>"))

    def test_strips_event_handlers(self):
        self.assertNotIn("onerror", self.s('<img src=x onerror="fetch(1)">'))

    def test_drops_javascript_href(self):
        self.assertNotIn("javascript:", self.s('<a href="javascript:alert(1)">x</a>'))

    def test_drops_data_href(self):
        self.assertNotIn("data:", self.s('<a href="data:text/html,x">x</a>'))

    def test_keeps_safe_link(self):
        self.assertIn('href="https://x.io"', self.s('<a href="https://x.io">x</a>'))

    def test_keeps_highlight_markup(self):
        self.assertIn('class="hl"', self.s('<div class="hl"><pre>x</pre></div>'))

    def test_keeps_heading_id_for_toc(self):
        self.assertIn('id="h1"', self.s('<h2 id="h1">t</h2>'))

    def test_keeps_formatting(self):
        self.assertIn("<strong>", self.s("<strong>bold</strong>"))


class TestEsc(unittest.TestCase):
    def test_quotes(self):
        self.assertIn("&quot;", render.esc('a"b'))
        self.assertIn("&#39;", render.esc("a'b"))

    def test_angle_brackets(self):
        self.assertEqual(render.esc("<b>"), "&lt;b&gt;")

    def test_ampersand_first(self):
        # & must be escaped before the entities it introduces, else double-escape
        self.assertEqual(render.esc("&<"), "&amp;&lt;")


class TestAutolink(unittest.TestCase):
    def al(self, h: str, mr: str | None = MR) -> str:
        return render.autolink(h, mr)

    def test_bare_url_linked(self):
        self.assertIn('href="https://example.com/x"',
                      self.al("<p>see https://example.com/x for detail</p>"))

    def test_existing_anchor_not_rewrapped(self):
        out = self.al('<p><a href="https://a.b">https://a.b</a></p>')
        self.assertEqual(out.count("<a "), 1)

    def test_code_span_inert(self):
        self.assertNotIn("<a", self.al("<p><code>curl https://x.y SCIF-11</code></p>"))

    def test_pre_block_inert(self):
        self.assertNotIn("<a", self.al('<pre class="hl">https://x.y !1234 SCIF-22</pre>'))

    def test_scif_key_linked(self):
        out = self.al("<p>fixed in SCIF-4799 today</p>")
        self.assertIn(f'href="{render.JIRA_BROWSE}SCIF-4799"', out)
        self.assertIn(">SCIF-4799</a>", out)

    def test_scif_inside_anchor_untouched(self):
        out = self.al('<p><a href="https://j/SCIF-1">SCIF-1 report</a></p>')
        self.assertEqual(out.count("<a"), 1)

    def test_mr_iid_linked(self):
        out = self.al("<p>merged via !1737 yesterday</p>")
        self.assertIn(f'href="{MR}1737"', out)

    def test_no_mr_base_leaves_iid(self):
        self.assertNotIn("<a", self.al("<p>merged via !1737</p>", mr=None))

    def test_double_bang_not_linked(self):
        self.assertNotIn("<a", self.al("<p>shell !!123 bang</p>"))

    def test_mermaid_token_survives(self):
        self.assertEqual(self.al("<p>@@MERMAID0@@</p>"), "<p>@@MERMAID0@@</p>")

    def test_entities_not_double_escaped(self):
        # regression: bleach.linkify re-escaped entities inside skip_tags, so pygments'
        # `-&gt;` became `-&amp;gt;` and code blocks rendered a literal `-&gt;`
        out = self.al('<div class="hl"><pre><span>def f() -&gt; str: x = &quot;hi&quot;</span></pre></div>')
        self.assertNotIn("&amp;gt;", out)
        self.assertNotIn("&amp;quot;", out)
        self.assertIn("-&gt;", out)

    def test_entities_in_prose_not_double_escaped(self):
        out = self.al("<p>a &amp; b &lt; c</p>")
        self.assertEqual(out, "<p>a &amp; b &lt; c</p>")

    def test_url_containing_scif_key_not_nested(self):
        # a browse URL literally contains a SCIF key -> a naive 2nd pass nests anchors
        out = self.al("<p>see https://mdpi.atlassian.net/browse/SCIF-4799 now</p>")
        self.assertEqual(out.count("<a "), 1)
        self.assertNotIn("</a></a>", out)

    def test_url_trailing_punctuation_excluded(self):
        out = self.al("<p>at https://ex.com/x, then https://ex.com/y.</p>")
        self.assertIn('href="https://ex.com/x"', out)
        self.assertIn('href="https://ex.com/y"', out)
        self.assertIn(",", out)
        self.assertTrue(out.rstrip().endswith(".</p>"))

    def test_www_url_gets_scheme(self):
        self.assertIn('href="https://www.ex.com"', self.al("<p>www.ex.com</p>"))


class TestFrontMatter(unittest.TestCase):
    def test_absent(self):
        meta, body = render.split_front_matter("# t\n\nx\n")
        self.assertEqual(meta, {})
        self.assertEqual(body, "# t\n\nx\n")

    def test_parsed_and_stripped(self):
        meta, body = render.split_front_matter("---\nTitle: Hi\nbadges: a, b\n---\nbody\n")
        self.assertEqual(render._meta_get(meta, "title"), "Hi")
        self.assertEqual(render._meta_get(meta, "badges"), "a, b")
        self.assertEqual(body, "body\n")

    def test_yaml_todos_and_bool(self):
        # Cursor/plan-style nested todos + bool — must survive as real structures
        src = ('---\nname: Sentry wire\nisProject: false\ntodos:\n'
               '  - id: "org-project"\n'
               '    content: "建项目拿 DSN"\n'
               '    status: pending\n'
               '  - id: sdk-wire\n'
               '    content: "装 @sentry/nuxt"\n'
               '    status: completed\n'
               '---\n\n# body\n')
        meta, body = render.split_front_matter(src)
        self.assertEqual(meta["isProject"], False)
        self.assertEqual(len(meta["todos"]), 2)
        self.assertEqual(meta["todos"][0]["id"], "org-project")
        self.assertEqual(meta["todos"][1]["status"], "completed")
        # closing ---\s*\n swallows the blank line after the fence
        self.assertEqual(body, "# body\n")

    def test_leading_html_comment_before_fence(self):
        # Cursor plans: <!-- uuid --> then --- todos --- (x.md shape)
        src = ('<!-- ed8bf4cc-e1a0-43b9-b6f7-76faa304c314 -->\n'
               '---\ntodos:\n'
               '  - id: a\n    content: one\n    status: pending\n'
               'isProject: false\n'
               '---\n# Title\n')
        meta, body = render.split_front_matter(src)
        self.assertEqual(meta["isProject"], False)
        self.assertEqual(meta["todos"][0]["id"], "a")
        self.assertEqual(body, "# Title\n")
        self.assertNotIn("ed8bf4cc", body)

    def test_title_from_front_matter_wins(self):
        title, body = render.extract_title({"title": "FM"}, "# H1\n", Path("/x/f.md"))
        self.assertEqual(title, "FM")
        self.assertIn("# H1", body)                 # h1 kept when FM supplies title

    def test_title_falls_back_to_name(self):
        title, body = render.extract_title({"name": "plan-x"}, "# H1\n", Path("/x/f.md"))
        self.assertEqual(title, "plan-x")
        self.assertIn("# H1", body)

    def test_title_from_h1_removed_from_body(self):
        title, body = render.extract_title({}, "# H1\n\nrest\n", Path("/x/f.md"))
        self.assertEqual(title, "H1")
        self.assertNotIn("# H1", body)

    def test_title_falls_back_to_stem(self):
        title, _ = render.extract_title({}, "no heading\n", Path("/x/my-report.md"))
        self.assertEqual(title, "my-report")

    def test_todos_html_statuses(self):
        html = render.render_todos_html([
            {"id": "a", "content": "done one", "status": "completed"},
            {"id": "b", "content": "doing one", "status": "in_progress"},
            {"id": "c", "content": "todo one", "status": "pending"},
            {"id": "d", "content": "nope", "status": "cancelled"},
        ])
        self.assertIn('class="todo todo-done"', html)
        self.assertIn('class="todo todo-doing"', html)
        self.assertIn('class="todo todo-pending"', html)
        self.assertIn('class="todo todo-cancelled"', html)
        self.assertIn(">done one<", html)
        self.assertIn('class="todo-id">a</code>', html)

    def test_meta_html_skips_reserved(self):
        html = render.render_meta_html({
            "title": "T", "badges": "x", "date": "2026-01-01", "template": "plan",
            "todos": [], "isProject": False, "overview": "wire sentry",
        })
        self.assertIn(">isProject<", html)
        self.assertIn(">false<", html)
        self.assertIn(">overview<", html)
        self.assertIn(">wire sentry<", html)
        self.assertNotIn(">title<", html)
        self.assertNotIn(">todos<", html)

    def test_meta_html_escapes(self):
        html = render.render_meta_html({"note": '<script>x</script>'})
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)


class TestMermaid(unittest.TestCase):
    def test_pull_replaces_with_token(self):
        body, blocks = render.pull_mermaid("a\n\n```mermaid\nflowchart LR\n```\n\nb\n")
        self.assertEqual(len(blocks), 1)
        self.assertIn("@@MERMAID0@@", body)
        self.assertNotIn("flowchart", body)

    def test_put_restores_escaped_pre(self):
        html = render.put_mermaid("<p>@@MERMAID0@@</p>", ["A-->B & <x>"])
        self.assertIn('<pre class="mermaid">', html)
        self.assertIn("&amp;", html)
        self.assertIn("&lt;x&gt;", html)
        self.assertNotIn("@@MERMAID0@@", html)

    def test_roundtrip_multiple(self):
        body, blocks = render.pull_mermaid("```mermaid\nA\n```\n\n```mermaid\nB\n```\n")
        self.assertEqual(len(blocks), 2)
        html = render.put_mermaid(body.replace("\n", ""), blocks)
        self.assertEqual(html.count('class="mermaid"'), 2)

    def test_non_mermaid_fence_untouched(self):
        body, blocks = render.pull_mermaid("```python\nx=1\n```\n")
        self.assertEqual(blocks, [])
        self.assertIn("```python", body)


class TestReadingTime(unittest.TestCase):
    def test_floor_one_minute(self):
        self.assertEqual(render.reading_time(""), 1)
        self.assertEqual(render.reading_time("hi"), 1)

    def test_counts_latin_words(self):
        self.assertEqual(render.reading_time(" ".join(["word"] * 460)), 2)

    def test_counts_cjk(self):
        self.assertEqual(render.reading_time("字" * 800), 2)


class TestPickTemplate(unittest.TestCase):
    def test_explicit_wins(self):
        self.assertEqual(render.pick_template(Path("/a/reviews/x.md"), "plan"), "plan")

    def test_unknown_explicit_falls_back(self):
        self.assertEqual(render.pick_template(Path("/a/x.md"), "nope"), "generic")

    def test_auto_by_path_segment(self):
        self.assertEqual(render.pick_template(Path("/a/reviews/x.md"), "auto"), "mr-review")
        self.assertEqual(render.pick_template(Path("/a/plans/x.md"), "auto"), "plan")
        self.assertEqual(render.pick_template(Path("/a/agent-knowledge-maintenance/x.md"), "auto"),
                         "kb-audit")

    def test_auto_default_generic(self):
        self.assertEqual(render.pick_template(Path("/a/b/x.md"), "auto"), "generic")


class TestResolveMd(unittest.TestCase):
    """Shared by CLI + serve — a hole here is a hole in the http surface."""

    def test_rejects_empty(self):
        with self.assertRaises(render.BadMd):
            render.resolve_md("")

    def test_rejects_non_markdown_suffix(self):
        p = _md("x\n").with_suffix(".txt")
        _ = p.write_text("x")
        with self.assertRaises(render.BadMd) as cm:
            render.resolve_md(str(p))
        self.assertEqual(cm.exception.code, 415)

    def test_missing_file_is_404(self):
        with self.assertRaises(render.BadMd) as cm:
            render.resolve_md("/nonexistent/nope.md")
        self.assertEqual(cm.exception.code, 404)

    def test_accepts_markdown_ext(self):
        p = _md("x\n")
        target = p.with_suffix(".markdown")
        _ = target.write_text("x")
        self.assertEqual(render.resolve_md(str(target)), target.resolve())

    def test_traversal_is_normalised(self):
        p = _md("x\n")
        sneaky = f"{p.parent}/../{p.parent.name}/r.md"
        self.assertEqual(render.resolve_md(sneaky), p.resolve())

    def test_directory_rejected(self):
        d = _md("x\n").parent
        with self.assertRaises(render.BadMd):
            render.resolve_md(str(d))


class TestCachePath(unittest.TestCase):
    def test_stable_for_same_source(self):
        self.assertEqual(render.cache_path(Path("/a/r.md")),
                         render.cache_path(Path("/a/r.md")))

    def test_same_stem_different_dir_disambiguated(self):
        self.assertNotEqual(render.cache_path(Path("/a/r.md")),
                            render.cache_path(Path("/b/r.md")))

    def test_never_beside_source(self):
        out = render.cache_path(Path("/a/r.md"))
        self.assertNotEqual(out.parent, Path("/a"))
        self.assertEqual(out.suffix, ".html")

    def test_ephemeral_path_is_temp_html(self):
        out = render.ephemeral_path(Path("/a/r.md"))
        try:
            self.assertTrue(out.name.startswith("r-"))
            self.assertEqual(out.suffix, ".html")
            self.assertNotEqual(out.parent, render.CACHE_DIR)
        finally:
            out.unlink(missing_ok=True)


class TestCacheMaintenance(unittest.TestCase):
    def setUp(self):
        self._prev = render.CACHE_DIR
        self.tmp = Path(tempfile.mkdtemp())
        render.CACHE_DIR = self.tmp

    def tearDown(self):
        render.CACHE_DIR = self._prev
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_clear_cache_entry(self):
        md = Path("/a/r.md")
        target = render.cache_path(md)
        target.write_text("<html/>")
        self.assertEqual(render.clear_cache_entry(md), target)
        self.assertFalse(target.exists())
        self.assertIsNone(render.clear_cache_entry(md))

    def test_clear_all_and_list(self):
        a = self.tmp / "a.html"
        b = self.tmp / "b.html"
        a.write_text("a")
        b.write_text("b")
        (self.tmp / "notes.txt").write_text("ignore")
        self.assertEqual(render.list_cache(), [a, b])
        removed = render.clear_all_cache()
        self.assertEqual(removed, [a, b])
        self.assertEqual(render.list_cache(), [])


class TestOpener(unittest.TestCase):
    def test_platform_specific(self):
        plat = sys.platform
        try:
            sys.platform = "darwin"
            self.assertEqual(render._opener(), "open")
            sys.platform = "linux"
            self.assertEqual(render._opener(), "xdg-open")
        finally:
            sys.platform = plat


class TestRenderEndToEnd(unittest.TestCase):
    def test_hostile_md_is_neutralised(self):
        p = _md('# T\n\nnormal <script>alert(1)</script>\n\n'
                '<img src=x onerror="fetch(0)">\n\n'
                '```python\nx = "<script>in code, escaped</script>"\n```\n\n'
                '```mermaid\nflowchart LR\n A-->B\n```\n')
        html = render.render(p, "generic")
        self.assertNotIn("<script>alert", html)
        self.assertNotIn("onerror=", html)
        self.assertIn("in code, escaped", html)
        self.assertIn('class="mermaid"', html)

    def test_mermaid_cdn_only_when_fenced(self):
        with_m = render.render(_md("# t\n\n```mermaid\nA-->B\n```\n"), "generic")
        without = render.render(_md("# t\n\nplain\n"), "generic")
        self.assertIn("mermaid.esm.min.mjs", with_m)
        self.assertNotIn("mermaid.esm.min.mjs", without)

    def test_toc_present_when_headings_and_absent_when_flat(self):
        deep = render.render(_md("# t\n\n## a\n\ntext\n\n## b\n\ntext\n"), "generic")
        flat = render.render(_md("# t\n\njust a paragraph\n"), "generic")
        self.assertIn('<nav class="toc">', deep)
        self.assertIn("with-toc", deep)
        self.assertIn("no-toc", flat)

    def test_pygments_classes_emitted(self):
        # three scopes: light base, auto-dark fenced + guarded against forced light,
        # forced dark via [data-theme] (must out-specify the base .hl rules)
        html = render.render(_md('# t\n\n```python\nx = 1\n```\n'), "generic")
        self.assertIn('class="hl"', html)
        self.assertIn("prefers-color-scheme: dark", html)
        self.assertIn(':root:not([data-theme="light"]) .hl', html)
        self.assertIn(':root[data-theme="dark"] .hl', html)

    def test_code_block_entities_single_escaped(self):
        # the browser must show `->` and `"`, not `-&gt;` and `&quot;`
        html = render.render(
            _md('# t\n\n```python\ndef f(x: str) -> str:\n    return "hi"\n```\n'), "generic")
        self.assertNotIn("&amp;gt;", html)
        self.assertNotIn("&amp;quot;", html)
        self.assertIn("-&gt;", html)

    def test_autolink_e2e_skips_code(self):
        html = render.render(
            _md("# t\n\nsee SCIF-100 and https://ex.com\n\n```\nSCIF-200 https://in.code\n```\n"),
            "generic")
        self.assertIn(f"{render.JIRA_BROWSE}SCIF-100", html)
        self.assertIn('href="https://ex.com', html)
        self.assertNotIn("SCIF-200</a>", html)
        self.assertNotIn('href="https://in.code', html)

    def test_backlink_slot(self):
        p = _md("# t\n\nx\n")
        self.assertIn('href="/">', render.render(p, "generic", backlink="/"))
        self.assertNotIn('class="back"', render.render(p, "generic"))

    def test_backlink_attribute_injection_escaped(self):
        html = render.render(_md("# t\n\nx\n"), "generic", backlink='"><script>x</script>')
        self.assertNotIn("<script>x</script>", html)

    def test_no_unfilled_template_slots(self):
        html = render.render(_md("# t\n\n## h\n\nx\n"), "generic")
        self.assertNotIn("{{", html)

    def test_front_matter_title_and_badges_render(self):
        html = render.render(_md("---\ntitle: Custom\nbadges: alpha, beta\n---\n\nbody\n"),
                             "generic")
        self.assertIn("<title>Custom</title>", html)
        self.assertIn(">alpha<", html)
        self.assertIn(">beta<", html)

    def test_front_matter_todos_and_meta_render(self):
        # user's plan-style example: todos checklist + leftover keys as meta card
        src = ('---\n'
               'name: Sentry FE\n'
               'overview: Wire @sentry/nuxt for prod\n'
               'isProject: false\n'
               'todos:\n'
               '  - id: "org-project"\n'
               '    content: "公司 Sentry 建 sciforum-frontend（Vue/Nuxt）项目并拿到 prod DSN"\n'
               '    status: pending\n'
               '  - id: "sdk-wire"\n'
               '    content: "安装 @sentry/nuxt"\n'
               '    status: completed\n'
               '  - id: "verify"\n'
               '    content: "prod 注入后验 Issues"\n'
               '    status: in_progress\n'
               '---\n\n'
               '## Plan body\n\n'
               'details here\n')
        html = render.render(_md(src), "plan")
        self.assertIn("<title>Sentry FE</title>", html)
        self.assertIn('class="fm-todos"', html)
        self.assertIn('class="fm-meta"', html)
        self.assertIn(">isProject<", html)
        self.assertIn(">false<", html)
        self.assertIn(">overview<", html)
        self.assertIn("公司 Sentry 建 sciforum-frontend", html)
        self.assertIn('data-status="pending"', html)
        self.assertIn('data-status="completed"', html)
        self.assertIn('data-status="in_progress"', html)
        self.assertIn('class="todo-id">org-project</code>', html)
        # name consumed as title — not duplicated in meta
        self.assertNotIn(">name<", html)
        self.assertIn("Plan body", html)

    def test_render_path_rejects_bad_input(self):
        with self.assertRaises(render.BadMd):
            render.render_path("/nonexistent/x.md")


class TestWrapTables(unittest.TestCase):
    """Every <table> gets a .table-scroll wrapper so wide tables scroll inside a
    rounded container instead of blowing out the article column."""

    def test_table_wrapped(self):
        out = render.wrap_tables("<p>a</p><table><tr><td>x</td></tr></table><p>b</p>")
        self.assertIn('<div class="table-scroll"><table>', out)
        self.assertIn("</table></div>", out)

    def test_no_table_untouched(self):
        html = "<p>plain</p>"
        self.assertEqual(render.wrap_tables(html), html)

    def test_e2e_md_table_wrapped(self):
        html = render.render(_md("# t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"), "generic")
        self.assertIn('<div class="table-scroll"><table>', html)


class TestRebaseImages(unittest.TestCase):
    """Relative sibling-image srcs must resolve when the page is served from a different
    origin/path than the report (the /render/<abs> viewer). Only <img> is touched."""

    def test_relative_src_prefixed_with_base(self):
        out = render.rebase_images('<img alt="" src="images/x.png">', "http://h/reports/d/")
        self.assertIn('src="http://h/reports/d/images/x.png"', out)

    def test_absolute_scheme_root_anchor_untouched(self):
        for src in ("/abs/x.png", "http://o/x.png", "data:image/png;base64,AA", "#f"):
            out = render.rebase_images(f'<img src="{src}">', "http://h/b/")
            self.assertIn(f'src="{src}"', out)

    def test_render_applies_base_only_when_given(self):
        p = _md("# t\n\n![](images/x.png)\n")
        self.assertIn('src="images/x.png"', render.render(p, "generic"))
        self.assertIn('src="http://b/reports/d/images/x.png"',
                      render.render(p, "generic", img_base="http://b/reports/d/"))


class TestServeSecurity(unittest.TestCase):
    """The http surface, driven for real: containment (finding), non-UTF-8 handling, base
    rewrite. Each spins the stdlib server on an ephemeral port and does a loopback GET."""

    def _get(self, path: str) -> tuple[int, str]:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), render.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            port = srv.server_address[1]
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}") as r:
                    return r.status, r.read().decode()
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode()
        finally:
            srv.shutdown()
            srv.server_close()

    @staticmethod
    def _render_path(md: Path, query: str = "") -> str:
        return "/render/" + urllib.parse.quote(str(md), safe="") + query

    def test_md_outside_roots_is_403(self):
        # a real md far from the allowlist must be refused, not disclosed
        secret = Path(tempfile.mkdtemp()) / "secret.md"
        _ = secret.write_text("# private\n")
        with mock.patch.dict(os.environ, {"REPORT_HTML_ROOTS": tempfile.mkdtemp()}):
            code, _body = self._get(self._render_path(secret))
        self.assertEqual(code, 403)

    def test_md_inside_roots_renders(self):
        d = Path(tempfile.mkdtemp())
        f = d / "ok.md"
        _ = f.write_text("# hi\n\nbody\n")
        with mock.patch.dict(os.environ, {"REPORT_HTML_ROOTS": str(d)}):
            code, body = self._get(self._render_path(f))
        self.assertEqual(code, 200)
        self.assertIn("<title>", body)

    def test_non_utf8_md_is_415_not_a_crash(self):
        # pre-fix: read_text() raised UnicodeDecodeError past the handler -> dropped connection
        d = Path(tempfile.mkdtemp())
        f = d / "bad.md"
        _ = f.write_bytes(b"# t\n\n\xff\xfe not utf-8\n")
        with mock.patch.dict(os.environ, {"REPORT_HTML_ROOTS": str(d)}):
            code, _body = self._get(self._render_path(f))
        self.assertEqual(code, 415)

    def test_base_param_rebases_sibling_images(self):
        d = Path(tempfile.mkdtemp())
        f = d / "r.md"
        _ = f.write_text("# t\n\n![](images/x.png)\n")
        base = "http://127.0.0.1:4400/reports/r/"
        q = "?base=" + urllib.parse.quote(base, safe="")
        with mock.patch.dict(os.environ, {"REPORT_HTML_ROOTS": str(d)}):
            code, body = self._get(self._render_path(f, q))
        self.assertEqual(code, 200)
        self.assertIn(base + "images/x.png", body)


class TestServeContract(unittest.TestCase):
    """Handler logic that is testable without a socket."""

    def test_local_hosts_accepted(self):
        for h in ("127.0.0.1", "127.0.0.1:4490", "localhost:4490", "[::1]:4490"):
            with self.subTest(h=h):
                bare = h.rsplit(":", 1)[0].strip("[]") if ":" in h else h
                self.assertIn(bare, {x.strip("[]") for x in render._LOCAL_HOSTS})

    def test_remote_host_rejected(self):
        self.assertNotIn("evil.com", {x.strip("[]") for x in render._LOCAL_HOSTS})

    def test_usage_page_has_routes(self):
        self.assertIn("/render/", render.USAGE_HTML)
        self.assertIn("/healthz", render.USAGE_HTML)

    def test_serve_csp_names_an_explicit_allowlist(self):
        # never a wildcard — default is 'none' (no framing) unless env opens it
        self.assertTrue(render.SERVE_CSP.startswith("frame-ancestors "))
        self.assertNotIn("*", render.SERVE_CSP)
        self.assertIn(render.FRAME_ANCESTORS, render.SERVE_CSP)

    @unittest.skipIf(
        os.environ.get("PASEO_MARKDOWN_FRAME_ANCESTORS")
        or os.environ.get("REPORT_HTML_FRAME_ANCESTORS"),
        "env overrides the default",
    )
    def test_frame_ancestors_default_to_none(self):
        self.assertEqual(render.FRAME_ANCESTORS, "'none'")

    def test_every_response_carries_the_csp_header(self):
        # header must ride _send(), not just the render route -> probe /healthz
        srv = ThreadingHTTPServer(("127.0.0.1", 0), render.Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{srv.server_address[1]}/healthz") as r:
                self.assertEqual(r.headers["Content-Security-Policy"], render.SERVE_CSP)
        finally:
            srv.shutdown()
            srv.server_close()


class TestNoLoopsCoupling(unittest.TestCase):
    """Structural guard: renderer stays a standalone uv script (no project imports)."""

    @staticmethod
    def _imported_roots() -> set[str]:
        import ast
        tree = ast.parse((HERE.parent / "render.py").read_text())
        roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                roots.add(node.module.split(".")[0])
        return roots

    def test_no_loops_imports(self):
        self.assertEqual(self._imported_roots() & {"watchers", "loops", "loop"}, set())

    def test_only_declared_third_party_deps(self):
        # anything outside stdlib must appear in the PEP-723 header
        third_party = self._imported_roots() & {"markdown", "pygments", "bleach", "yaml"}
        header = (HERE.parent / "render.py").read_text().split("# ///")[1]
        # import name is `yaml`; PEP-723 package name is `pyyaml`
        pkg = {"yaml": "pyyaml"}.get
        for dep in third_party:
            with self.subTest(dep=dep):
                self.assertIn(pkg(dep, dep), header)

    def test_no_dashboard_runtime_coupling(self):
        # these would mean we still talk to / boot the loops web daemon
        src = (HERE.parent / "render.py").read_text()
        for bad in ("LOOP_WEB_PORT", "api/state", "ensure_dashboard", "viewer_url"):
            with self.subTest(token=bad):
                self.assertNotIn(bad, src)


class TestShebang(unittest.TestCase):
    """render.py IS the symlink target. Shebang = `env -S uv run --script` (portable,
    user call 2026-07-10). CAVEAT lives in the Makefile: headless callers (ssh, cron,
    systemd) must prepend ~/.local/bin to PATH themselves."""

    @property
    def line1(self) -> str:
        return (HERE.parent / "render.py").read_text().splitlines()[0]

    def test_executable(self):
        self.assertTrue(os.access(HERE.parent / "render.py", os.X_OK))

    def test_env_s_uv_shebang(self):
        self.assertEqual(self.line1, "#!/usr/bin/env -S uv run --script")

    def test_runs_uv_as_script(self):
        self.assertTrue(self.line1.endswith("uv run --script"), self.line1)

    def test_uv_resolvable_on_this_box(self):
        # env -S resolves uv off PATH; ~/.local/bin is where astral.sh puts it
        found = shutil.which("uv") or (Path.home() / ".local/bin/uv")
        self.assertTrue(Path(found).is_file(), "uv missing — astral.sh install")

    def test_pep723_header_intact(self):
        # uv reads deps from the comment block; the shebang comment must not break it
        src = (HERE.parent / "render.py").read_text()
        self.assertIn("# /// script", src)
        for dep in ("markdown", "pygments", "bleach", "pyyaml"):
            with self.subTest(dep=dep):
                self.assertIn(dep, src.split("# ///")[1])


if __name__ == "__main__":
    unittest.main()
