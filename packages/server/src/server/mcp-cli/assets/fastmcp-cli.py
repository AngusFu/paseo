#!/usr/bin/env python3
"""fastmcp-backed CLI for the figma / atlassian MCP servers.

Auth core = fastmcp StreamableHttpTransport + OAuth (pre-registered client from oauth-clients.json
→ skips DCR, fixed callback_port for strict redirect_uri, DiskStore persistence → browser once).
AS metadata is pre-seeded per call (disk-cached) so cold-start token refresh hits the REAL
token_endpoint — see the comment above _meta_file for the mcp-SDK bug this works around.
Native MCP surface — tool + flag names are the server's own (camelCase), no translation layer:

  <server> [--json] <toolName> [--flagName val ...]   # call tool (flag = schema property verbatim)
  <server> --json <toolName> ...                       # JSON out (fastmcp CallToolResult envelope)
  <server> <toolName> --help                           # flags for a tool (offline, uses cache)
  <server> --list / --search <kw>                      # tools (live, refreshes cache)

server (atlassian|figma) = argv[1], injected by the ~/.local/bin/<server> launcher.

Transport: explicit StreamableHttpTransport (one request/response) — a fresh connection is made
per invocation, so we avoid SSE (which holds a stream open) and skip transport auto-detection.
Tool schemas are cached on disk (SCHEMA_DIR) so a normal call does NOT pay a list_tools round-trip;
the cache refreshes on --list/--search or when an unknown tool is requested.
OAuth client + url + scope + redirect come from ~/.config/sciforum/oauth-clients.json (pre-registered
client_id/secret per server; figma/atlassian block DCR so these are reused, never re-minted). Secrets
never printed.

SOURCE OF TRUTH: the canonical copy is the repo file .claude/scripts/remote-dev/fastmcp-cli.py;
install-fastmcp-cli.sh copies it to ~/.config/sciforum/fastmcp-cli.py (the running copy). Edit the
repo copy (or sync the running copy back with `cp`) — the two must stay identical, do not let drift.
"""
import asyncio, difflib, fcntl, json, os, re, shutil, subprocess, sys, textwrap, time, traceback

# Paseo layout: $PASEO_HOME/mcp-cli/{oauth-clients.json,cache/,...}
# Launchers pass PASEO_MCP_CLI_ROOT; fall back to ~/.paseo/mcp-cli for manual runs.
_ROOT = os.path.expanduser(os.environ.get("PASEO_MCP_CLI_ROOT") or "~/.paseo/mcp-cli")
CONFIG = os.path.join(_ROOT, "oauth-clients.json")
STORE_DIR = os.path.join(_ROOT, "cache", "oauth")
SCHEMA_DIR = os.path.join(_ROOT, "cache", "schema")
CACHE_TTL = 86400  # refetch tool schemas at least daily (server may add tools/required fields)
META_TTL = 7 * 86400  # AS metadata (token_endpoint etc) is stable; weekly refetch, stale fallback
MISS_TTL = 300  # failed discovery negative-cache: don't re-storm well-knowns on every call
LOCK_TIMEOUT = 30  # max seconds to wait for the per-server refresh lock before proceeding unlocked
AUTH_LOG = os.path.join(_ROOT, "cache", "auth.log")  # token/refresh/re-auth trail
# presence = this host may NOT refresh (passive token consumer). File, not env: see _install_refresh_guard.
PASSIVE_MARKER = os.path.join(_ROOT, "passive-consumer")
_LOCK_FDS = []  # hold acquired flock fds open for process lifetime (close = release)
# last-resort OAuth token endpoints (stable, well-known per AS). When BOTH the authmeta cache AND
# live discovery miss (or the SDK rejects the discovered doc), oauth_metadata would stay None and
# the SDK refreshes against urljoin(mcp_url, "/token") = mcp.<host>/token -> 404 -> tokens cleared
# -> full browser re-auth. Synthesizing minimal metadata from these guarantees the refresh always
# hits the RIGHT host, so a transient discovery miss can never force a re-auth. If a full 401 flow
# ever runs, async_auth_flow re-discovers complete metadata and overwrites this stub.
FALLBACK_TOKEN_ENDPOINT = {
    "atlassian": "https://auth.atlassian.com/oauth/token",
    "figma": "https://api.figma.com/v1/oauth/token",
}


def _auth_log(server, msg):
    # append-only token/auth trail: the daily re-auth was invisible until we logged it. Cheap,
    # best-effort, never fails the call. Grep this to see refresh success/fail + the NO_PROXY canary.
    try:
        os.makedirs(os.path.dirname(AUTH_LOG), exist_ok=True)
        with open(AUTH_LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{server}] {msg}\n")
    except Exception:
        pass


def _attach_sdk_auth_logging():
    # route the mcp-SDK + fastmcp OAuth loggers into AUTH_LOG so their own signals land here —
    # notably `_handle_refresh_response`'s "Token refresh failed: <status>" warning (the smoking
    # gun when a refresh is REJECTED vs a connection error). Idempotent per process.
    import logging
    if getattr(_attach_sdk_auth_logging, "_done", False):
        return
    try:
        os.makedirs(os.path.dirname(AUTH_LOG), exist_ok=True)
        h = logging.FileHandler(AUTH_LOG)
        h.setFormatter(logging.Formatter("%(asctime)s [sdk:%(name)s] %(levelname)s %(message)s"))
        for name in ("mcp.client.auth", "fastmcp", "mcp.client.auth.oauth2"):
            lg = logging.getLogger(name)
            lg.addHandler(h)
            if lg.level == logging.NOTSET or lg.level > logging.INFO:
                lg.setLevel(logging.INFO)
        _attach_sdk_auth_logging._done = True
    except Exception:
        pass


def _patch_refresh_body_logging():
    # The SDK's _handle_refresh_response logs only the status ("Token refresh failed: 403") — not the
    # body, which is the ONLY thing that tells a rotated/consumed refresh_token (invalid_grant / reuse
    # detection) apart from a revoked/expired one. Wrap it to log the body on any non-200, then defer to
    # the original (which clears tokens + returns). Body carries no secret — the refresh_token is in the
    # REQUEST, the response is just the AS error JSON. Idempotent, best-effort.
    if getattr(_patch_refresh_body_logging, "_done", False):
        return
    try:
        from mcp.client.auth.oauth2 import OAuthClientProvider
        orig = OAuthClientProvider._handle_refresh_response

        async def wrapped(self, response):
            if response.status_code != 200:
                try:
                    body = (await response.aread()).decode("utf-8", "replace")[:500]
                except Exception:
                    body = "<unreadable>"
                _auth_log("sdk", f"refresh {response.status_code} body={body!r}")
            return await orig(self, response)

        OAuthClientProvider._handle_refresh_response = wrapped
        _patch_refresh_body_logging._done = True
    except Exception:
        pass  # SDK internals moved -> body logging quietly off, everything else still works


def _install_refresh_guard(server):
    # Marks this host a passive token CONSUMER (the asus box). The Mac owns the single Atlassian
    # token family and pushes its DiskStore here; Atlassian RTs are rotating and single-use, so a
    # refresh on THIS host would consume the Mac's RT and force a browser re-auth there — exactly the
    # 2026-07-18 bug. Make refresh impossible rather than merely unlikely: replace the SDK's
    # refresh-request builder with a raise. Fail CLOSED — if the patch cannot be installed we abort,
    # because proceeding risks silently rotating the Mac's token away.
    #
    # The MARKER FILE is the real switch, not the env var: toolchain.sh only reaches shells that
    # source an rc, so a non-interactive caller (`ssh box 'atlassian ...'`, a daemon spawning a clean
    # env) silently lost FASTMCP_NO_REFRESH and ran UNGUARDED — measured, not theorised. A file on
    # disk is intrinsic to the host and survives any spawn path. Env var kept as a manual override.
    if os.environ.get("FASTMCP_NO_REFRESH") != "1" and not os.path.exists(PASSIVE_MARKER):
        return
    try:
        from mcp.client.auth.oauth2 import OAuthClientProvider

        def blocked(self, *a, **kw):
            raise RuntimeError(
                "refresh blocked: this host is a passive token consumer and the access token is stale.\n"
                "This box consumes tokens minted on the Mac — refreshing here would consume the "
                "Mac's rotating refresh_token and force a browser re-auth there.\n"
                "Fix: run `bash .claude/scripts/remote-dev/sync-secrets-to-asus.sh` on the Mac.")

        OAuthClientProvider._refresh_token = blocked
        why = "env FASTMCP_NO_REFRESH=1" if os.environ.get("FASTMCP_NO_REFRESH") == "1" else f"marker {PASSIVE_MARKER}"
        _auth_log(server, f"refresh guard installed (passive consumer, via {why})")
    except Exception as e:
        _auth_log(server, f"refresh guard FAILED to install: {e}")
        die(f"FASTMCP_NO_REFRESH=1 but the refresh guard could not be installed ({e}).\n"
            "Refusing to run: an unguarded refresh here would rotate the Mac's token away.")


def _acquire_lock(server):
    # Atlassian ROTATES the refresh_token on every refresh (old one consumed). Each CLI call is a fresh
    # process with NO cross-process coordination, so two concurrent atlassian calls (common under
    # parallel agents) both read the same RT; the 1st rotates it, the 2nd presents the now-consumed RT
    # -> 403, and Atlassian's reuse-detection revokes the whole token family -> browser re-auth. An
    # exclusive per-server flock, held for the whole session (fd kept until process exit), forces the
    # read->refresh->write window to run one process at a time. Best-effort: on timeout/failure we
    # proceed unlocked (a possible race beats a hang) and log it.
    try:
        os.makedirs(STORE_DIR, exist_ok=True)
        fd = open(os.path.join(STORE_DIR, f"{server}.lock"), "w")
    except Exception as e:
        _auth_log(server, f"lock: open failed, proceeding unlocked: {e}")
        return
    start = time.time()
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            waited = time.time() - start
            if waited > 1:
                _auth_log(server, f"lock: acquired after {waited:.1f}s wait (serialized a concurrent call)")
            _LOCK_FDS.append(fd)  # keep open -> lock held until this process exits
            return
        except OSError:
            if time.time() - start >= LOCK_TIMEOUT:
                _auth_log(server, f"lock: timeout after {LOCK_TIMEOUT}s; proceeding unlocked (race possible)")
                _LOCK_FDS.append(fd)
                return
            time.sleep(0.2)


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def norm(s: str) -> str:
    # case/separator-insensitive key: getJiraIssue == get-jira-issue == get_jira_issue == getjiraissue
    return re.sub(r"[-_\s]", "", s).lower()


# --- fuzzy tool search (pure stdlib: difflib) --------------------------------------------------
def words(s: str):
    # split camelCase / snake / kebab / spaces / ACRONYMs -> lowercase tokens: getJiraIssue -> [get,jira,
    # issue]; getHTMLPage -> [get,html,page] (2nd rule = acronym|Word boundary).
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", s or "")
    return [w for w in re.split(r"[^a-z0-9]+", s.lower()) if w]


def subseq(q: str, s: str) -> bool:  # chars of q appear in s in order (abbrev: "gji" in "getjiraissue")
    it = iter(s)
    return all(c in it for c in q)


def term_score(term: str, name: str, name_words, desc: str) -> int:
    # one query term vs one tool. layered: exact > whole-word > prefix > substring > typo > subseq > desc.
    # a 1-char term matches ONLY a whole word — prefix/substring/subseq/desc are length-guarded so a lone
    # letter can't keep the whole catalog alive in an AND search.
    n = name.lower()
    if term == n:                                        return 100
    if term in name_words:                               return 90
    if len(term) >= 2 and any(w.startswith(term) for w in name_words): return 72
    if len(term) >= 2 and term in n:                     return 55
    best = 0
    for w in name_words:                       # per-word typo tolerance (comment vs coment)
        r = difflib.SequenceMatcher(None, term, w).ratio()
        if r > 0.8:
            best = max(best, int(40 + (r - 0.8) * 100))   # 40..60
    if len(term) >= 3 and subseq(term, n):
        best = max(best, 30)
    if best:                                             return best
    if len(term) >= 2 and term in (desc or "").lower():  return 20
    return 0


def load_cfg(server: str) -> dict:
    if not os.path.exists(CONFIG):
        die(f"oauth config not found: {CONFIG} — save a server in Host → FastMCP first")
    all_cfg = json.load(open(CONFIG))
    if server not in all_cfg:
        die(f"unknown server '{server}' (have: {', '.join(all_cfg) or 'none'})")
    c = all_cfg[server]
    transport = c.get("transport") or ("stdio" if c.get("command") and not c.get("source") else "http")
    if transport == "stdio":
        command = c.get("command")
        if not command:
            die(f"{server}: stdio config missing 'command'")
        args = c.get("args") or []
        if not isinstance(args, list):
            die(f"{server}: stdio 'args' must be a list")
        env = c.get("env") or {}
        if not isinstance(env, dict):
            die(f"{server}: stdio 'env' must be an object")
        return {
            "transport": "stdio",
            "command": command,
            "args": [str(a) for a in args],
            "env": {str(k): str(v) for k, v in env.items()},
            "cwd": c.get("cwd") or None,
        }
    if not c.get("source"):
        die(f"{server}: oauth-clients.json missing 'source'")
    # oauth_client_id optional: present → OAuth; absent → open HTTP (no auth wrapper).
    redir = c.get("oauth_redirect_uri") or ""
    m = re.search(r"localhost:(\d+)", redir)
    return {
        "transport": "http",
        "url": c["source"],
        "client_id": c.get("oauth_client_id") or None,
        "client_secret": c.get("oauth_client_secret"),
        "scope": c.get("oauth_scope"),
        "callback_port": int(m.group(1)) if m else None,
    }


# --- AS metadata pre-seed: works around an mcp-SDK cold-start refresh bug ----------------------
# The SDK only learns token_endpoint during the full 401 OAuth flow and never persists it. Each CLI
# invocation is a fresh process, so at refresh time context.oauth_metadata is None and _refresh_token
# falls back to urljoin(origin, "/token") — 404 on atlassian — refresh fails, tokens get cleared,
# and the full browser flow re-runs on every access-token expiry (8h for atlassian). Pre-seeding the
# real AS metadata (discovered like the SDK: PRM -> authorization_servers[0] -> RFC 8414 well-known,
# disk-cached) makes the silent refresh path actually work. Best-effort: any failure -> stock behavior.
# Two sources, capture wins: capture_auth_metadata persists what the SDK's own full flow actually
# used (ground truth, lineage: legacy mcp2cli-wrapped.py sidecar); discovery only seeds/bridges gaps.
def _meta_file(server):
    return os.path.join(SCHEMA_DIR, f"{server}.authmeta.json")


def _discover_auth_metadata(url):
    import httpx
    from urllib.parse import urlsplit

    sp = urlsplit(url)
    origin = f"{sp.scheme}://{sp.netloc}"
    # trust_env=False: AS host (auth.atlassian.com) is outside NO_PROXY at this point and the
    # local dev proxy can't be relied on — MCP hosts are reached direct anyway, so go direct
    with httpx.Client(timeout=5, follow_redirects=True, trust_env=False) as h:
        def get(u):
            try:
                r = h.get(u)
                return r.json() if r.status_code == 200 else None
            except Exception:
                return None

        prm = get(f"{origin}/.well-known/oauth-protected-resource{sp.path}") \
            or get(f"{origin}/.well-known/oauth-protected-resource")
        servers = (prm or {}).get("authorization_servers")
        as_url = servers[0] if isinstance(servers, list) and servers else origin
        asp = urlsplit(as_url)
        as_origin = f"{asp.scheme}://{asp.netloc}"
        path = asp.path.rstrip("/")
        for u in ([f"{as_origin}/.well-known/oauth-authorization-server{path}"]
                  + ([f"{as_origin}{path}/.well-known/oauth-authorization-server"] if path else [])
                  + [f"{as_origin}/.well-known/openid-configuration{path}"]):
            m = get(u)
            if m and m.get("token_endpoint"):
                return m
    return None


def load_auth_metadata(server, url):
    p = _meta_file(server)
    cached = None
    try:
        with open(p) as f:
            cached = json.load(f)
        if time.time() - os.path.getmtime(p) <= META_TTL:
            return cached
    except Exception:
        pass
    miss = p + ".miss"
    try:
        if time.time() - os.path.getmtime(miss) <= MISS_TTL:  # recent failure -> no retry storm
            return cached
    except Exception:
        pass
    m = _discover_auth_metadata(url)
    if m:
        _write_auth_metadata(server, m)
        try:
            os.remove(miss)
        except OSError:
            pass
        return m
    try:  # negative cache the miss so a dead well-known costs one probe per MISS_TTL, not per call
        os.makedirs(SCHEMA_DIR, exist_ok=True)
        with open(miss, "w"):
            pass
        os.utime(miss)
    except Exception:
        pass
    return cached  # discovery down -> stale metadata beats none


def _write_auth_metadata(server, m):
    os.makedirs(SCHEMA_DIR, exist_ok=True)
    p = _meta_file(server)
    tmp = f"{p}.{os.getpid()}.tmp"  # pid-unique: concurrent CLIs must not interleave one tmp
    with open(tmp, "w") as f:
        json.dump(m, f)
    os.replace(tmp, p)


def capture_auth_metadata(server, client):
    """mcp2cli-era wisdom: after a session, persist whatever metadata the SDK ACTUALLY used.
    A full 401 flow discovers metadata itself — that ground truth beats our own discovery
    (heals divergence) and bumps the cache mtime so the TTL refetch rarely fires."""
    try:
        md = client.transport.auth.context.oauth_metadata
        if md is None:
            return
        m = md.model_dump(mode="json", exclude_none=True)
        p = _meta_file(server)
        try:
            with open(p) as f:
                if json.load(f) == m:
                    os.utime(p)  # unchanged -> just keep it fresh
                    return
        except Exception:
            pass
        _write_auth_metadata(server, m)
    except Exception:
        pass  # capture is best-effort bookkeeping, never fail the call


def make_client(server: str):
    import os as _os
    # macOS can raise PermissionError from os.getcwd() for directories guarded by TCC.
    # If that happens, fall back to the user's home dir so downstream imports (e.g. rich)
    # which call os.getcwd() succeed.
    try:
        _os.getcwd()
    except PermissionError:
        try:
            _os.chdir(_os.path.expanduser("~"))
        except Exception:
            pass

    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport, StreamableHttpTransport

    c = load_cfg(server)
    if c.get("transport") == "stdio":
        # CLI is one-shot per process; do not keep the child alive across contexts.
        env = {**os.environ, **(c.get("env") or {})}
        return Client(
            StdioTransport(
                command=c["command"],
                args=c.get("args") or [],
                env=env,
                cwd=c.get("cwd") or None,
                keep_alive=False,
            )
        )

    # Open HTTP: no OAuth client → no auth wrapper (avoids DCR / browser on public endpoints).
    if not c.get("client_id"):
        return Client(StreamableHttpTransport(c["url"]))

    from fastmcp.client.auth import OAuth
    from key_value.aio.stores.disk import DiskStore

    _attach_sdk_auth_logging()
    _patch_refresh_body_logging()
    _install_refresh_guard(server)  # passive-consumer hosts must never rotate the owner's token
    _acquire_lock(server)  # serialize concurrent calls so refresh-token rotation can't race -> 403
    os.makedirs(STORE_DIR, exist_ok=True)
    oauth = OAuth(
        mcp_url=c["url"],
        client_id=c["client_id"],
        client_secret=c["client_secret"],
        scopes=c["scope"],
        callback_port=c["callback_port"],
        token_storage=DiskStore(directory=STORE_DIR),
    )
    try:
        from mcp.shared.auth import OAuthMetadata
        from urllib.parse import urlsplit

        m = load_auth_metadata(server, c["url"])
        om = None
        if m:
            try:
                om = OAuthMetadata.model_validate(m)  # canary: SDK model bump could reject the doc
            except Exception as e:
                _auth_log(server, f"discovered metadata rejected by SDK model: {e}")
                om = None
        if om is None and server in FALLBACK_TOKEN_ENDPOINT:
            # cache+discovery both missed (or SDK rejected the doc): synthesize minimal metadata from
            # the stable well-known token endpoint so oauth_metadata is NEVER None -> the SDK's refresh
            # can't degrade to mcp.<host>/token (404) -> no transient re-auth. A full 401 flow, if it
            # ever runs, re-discovers complete metadata (async_auth_flow overwrites this stub).
            te = FALLBACK_TOKEN_ENDPOINT[server]
            origin = f"{urlsplit(te).scheme}://{urlsplit(te).netloc}"
            om = OAuthMetadata.model_validate({
                "issuer": origin, "authorization_endpoint": f"{origin}/authorize",
                "token_endpoint": te, "response_types_supported": ["code"]})
            _auth_log(server, f"pre-seed FALLBACK token_endpoint={te} (cache+discovery missed)")
        if om is not None:
            oauth.context.oauth_metadata = om
            te = str(om.token_endpoint)
            if os.environ.get("FASTMCP_DEBUG"):  # canary for a future SDK bump silently breaking this
                print(f"[debug] {server}: pre-seeded token_endpoint {te}", file=sys.stderr)
            # token endpoint can live off-origin (auth.atlassian.com) where the local dev proxy can't
            # reach — extend NO_PROXY in-process so the refresh POST goes direct. Canary logs whether
            # the persistent NO_PROXY already covered it (False = the toolchain.sh gap is back).
            host = urlsplit(te).hostname
            in_np = host in [x.strip() for x in os.environ.get("NO_PROXY", "").split(",")]
            _auth_log(server, f"pre-seed token_endpoint={te} host={host} persistent_NO_PROXY={in_np}")
            if host:
                for var in ("NO_PROXY", "no_proxy"):
                    cur = os.environ.get(var, "")
                    if host not in [x.strip() for x in cur.split(",")]:
                        os.environ[var] = f"{cur},{host}" if cur else host
    except Exception as e:
        _auth_log(server, f"pre-seed FAILED (falls back to browser flow on refresh): {e}")
        pass  # pre-seed is an optimization; stock (browser) flow still works without it
    return Client(StreamableHttpTransport(c["url"], auth=oauth))


# --- disk schema cache: {toolName: {"description":.., "inputSchema":..}} -----------------------
def _cache_file(server):
    return os.path.join(SCHEMA_DIR, f"{server}.json")


def load_cache(server):
    p = _cache_file(server)
    try:
        if time.time() - os.path.getmtime(p) > CACHE_TTL:  # stale → force a live refetch
            return None
        with open(p) as f:
            return json.load(f)
    except Exception:  # missing / corrupt → caller refetches
        return None


async def fetch_tools(server):
    cli = make_client(server)
    async with cli:
        tools = await cli.list_tools()
    capture_auth_metadata(server, cli)
    meta = {t.name: {"description": t.description, "inputSchema": t.inputSchema} for t in tools}
    os.makedirs(SCHEMA_DIR, exist_ok=True)
    tmp = f"{_cache_file(server)}.{os.getpid()}.tmp"  # pid-unique, see _write_auth_metadata
    with open(tmp, "w") as f:  # flush+close BEFORE atomic replace
        json.dump(meta, f)
    os.replace(tmp, _cache_file(server))
    return meta


def coerce(val: str, schema: dict, tool: str, key: str):
    t = (schema or {}).get("type")
    if t in ("object", "array"):
        try: return json.loads(val)
        except Exception: die(f"{tool}: --{key} expects a JSON {t}, got {val!r}")
    if t == "boolean":
        return val.lower() in ("1", "true", "yes", "on")
    if t == "integer":
        try: return int(val)
        except Exception: die(f"{tool}: --{key} expects an integer, got {val!r}")
    if t == "number":
        try: return float(val)
        except Exception: die(f"{tool}: --{key} expects a number, got {val!r}")
    return val


def parse_tool_args(argv, props: dict, tool: str, server: str) -> dict:
    """Map --flags to schema properties (case/separator-insensitive), coerce by type. Repeats -> list.
    Reserved `--args '<json object>'` supplies the whole payload at once (individual --flags override it).
    Unknown flags error with a suggestion; the required-field check happens in run()."""
    canon = {norm(k): k for k in props}  # any-style flag -> real schema property
    base, out = {}, {}                   # base = from --args; out = individual flags (win over base)
    i = 0
    while i < len(argv):
        tok = argv[i]
        if not tok.startswith("-"):
            die(f"{tool}: unexpected argument '{tok}' (expected --flag; see `{server} {tool} --help`)")
        raw = tok.lstrip("-")
        eq = None
        if "=" in raw:
            raw, eq = raw.split("=", 1)
        n = norm(raw)
        # `--args`/`--jsonargs`/`--rawargs` = whole-payload JSON, but ONLY when the tool has no real
        # property by that name (else the real prop wins — e.g. a genuine `--body`/`--args` field).
        reserved = n in ("args", "jsonargs", "rawargs") and n not in canon
        key = None if reserved else canon.get(n)
        if not reserved and key is None:  # resolve flag BEFORE consuming a value (clear error)
            byn = {norm(k): k for k in props}
            near = difflib.get_close_matches(n, list(byn), n=1, cutoff=0.6)
            dym = f" did you mean --{byn[near[0]]}?" if near else ""
            hint = ", ".join("--" + k for k in list(props)[:6]) or "(no flags)"
            die(f"{tool}: unknown flag --{raw}.{dym} valid: {hint}{' …' if len(props) > 6 else ''}  (see `{server} {tool} --help`)")
        # fetch this flag's value (bool flags may stand alone)
        is_bool = (key is not None) and props.get(key, {}).get("type") == "boolean"
        if eq is not None:
            val = eq; i += 1
        elif is_bool and (i + 1 >= len(argv) or argv[i + 1].startswith("--")):
            val = "true"; i += 1
        else:
            if i + 1 >= len(argv): die(f"{tool}: flag --{raw} needs a value")
            val = argv[i + 1]; i += 2
        if reserved:  # verbatim payload merge (server validates extra keys)
            try:
                obj = json.loads(val)
            except Exception as e:
                die(f"{tool}: --{raw} must be a JSON object ({e})")
            if not isinstance(obj, dict):
                die(f"{tool}: --{raw} must be a JSON object, got {type(obj).__name__}")
            base.update(obj)
            continue
        cval = coerce(val, props.get(key, {}), tool, key)
        if key in out:
            if not isinstance(out[key], list): out[key] = [out[key]]
            out[key].append(cval)
        else:
            out[key] = cval
    return {**base, **out}


def desc1(d):  # one-line, flattened description for list/search
    return " ".join((d or "").split())[:100]


def type_str(s):  # human type incl array item / object hints
    t = s.get("type", "string")
    if t == "array":
        it = (s.get("items") or {}).get("type", "any")
        return f"array<{it}>"
    if t == "object":
        return "object"
    return t


async def run():
    args = sys.argv[1:]
    if not args:
        die("usage: <server> [--json] <tool|--list|--search kw> [--flags]")
    server = args.pop(0)

    as_json = False
    if args and args[0] == "--json":
        as_json = True; args.pop(0)

    if args and args[0] in ("--list", "-l"):
        meta = await fetch_tools(server)  # live, refreshes cache
        for name, m in meta.items():
            req = ",".join(m["inputSchema"].get("required", []))
            print(f"{name:40} {desc1(m['description'])}".rstrip() + (f"  [req: {req}]" if req else ""))
        print(f"\nfull catalog + rules: .claude/knowledge/cli/{server}.md   (per-tool flags: {server} <tool> --help)")
        return

    if args and args[0] == "--search":
        terms = [t.lower() for t in args[1:] if t]  # multi-word: fuzzy, layered scoring
        if not terms:
            die(f"usage: {server} --search <keyword ...>  (or `{server} --list` for all tools)")
        meta = await fetch_tools(server)
        scored = []  # (total, name, m): total = sum of per-term scores
        for name, m in meta.items():
            nw = words(name)
            per = [term_score(t, name, nw, m["description"]) for t in terms]
            if all(p > 0 for p in per):             # AND: every term hits something
                scored.append((sum(per), name, m))
        if not scored:                              # OR fallback: no tool matched ALL terms → best-effort
            for name, m in meta.items():
                nw = words(name)
                s = sum(term_score(t, name, nw, m["description"]) for t in terms)
                if s:
                    scored.append((s, name, m))
        for _, name, m in sorted(scored, key=lambda x: -x[0]):  # ranked, uncapped (n≈31)
            print(f"{name:40} {desc1(m['description'])}".rstrip())
        return

    if not args or args[0] in ("-h", "--help"):
        rows = [
            (f"{server} [--json] <tool> [--flag val ...]", "call a tool"),
            (f"{server} --list", "list all tools"),
            (f"{server} --search <keyword>", "find tools by keyword"),
            (f"{server} <tool> --args '<json>'", "pass the whole payload as one JSON object"),
            (f"{server} <tool> --help", "show a tool's flags"),
        ]
        w = max(len(left) for left, _ in rows)
        print(f"{server} — fastmcp CLI for the {server} MCP server\n\nusage:")
        for left, desc in rows:
            print(f"  {left:<{w}}   {desc}")
        print("\nflags map to the tool's native schema properties (any case/separator style — --cloudId /")
        print("--cloud-id both work); object/array values take a JSON string. --args merges with --flags.")
        print("\nplain output = the tool's payload — pipe to jq directly: `... | jq '.fields.status.name'`.")
        print("--json wraps it in the CallToolResult envelope (.content[0].text) — use only to inspect an")
        print("error (isError) or non-text blocks.")
        print(f"\nfull command catalog + project rules: .claude/knowledge/cli/{server}.md")
        return
    tool_in = args.pop(0)

    # resolve tool (case/separator-insensitive) from cache; refresh live only on miss
    def resolve(m):
        return {norm(n): n for n in (m or {})}.get(norm(tool_in))
    meta = load_cache(server)
    tool = resolve(meta)
    if tool is None:
        meta = await fetch_tools(server)
        tool = resolve(meta)
        if tool is None:
            byn = {norm(n): n for n in meta}
            near = difflib.get_close_matches(norm(tool_in), list(byn), n=3, cutoff=0.5)
            dym = "  did you mean: " + ", ".join(byn[c] for c in near) + "?" if near else ""
            die(f"unknown tool '{tool_in}'.{dym}  (try `{server} --list` / `{server} --search {tool_in}`)")
    schema = meta[tool]["inputSchema"]
    props = schema.get("properties", {})
    required = set(schema.get("required", []))

    if "--help" in args or "-h" in args:  # offline, rendered from the cached schema
        full = " ".join((meta[tool]["description"] or "").split())
        print(f"{tool}\n")
        for line in textwrap.wrap(full, width=92) or [""]:
            print(f"  {line}")
        if not props:
            print("\n  (no arguments)"); return
        print("\narguments  (* = required; object/array values take a JSON string):")
        for k, s in props.items():
            star = "*" if k in required else " "
            print(f"\n  {star} --{k}  \033[2m{type_str(s)}\033[0m")
            d = " ".join((s.get("description") or "").split())
            for line in textwrap.wrap(d, width=88):
                print(f"        {line}")
            extra = []
            if s.get("enum"):
                extra.append("choices: " + " | ".join(str(x) for x in s["enum"]))
            if s.get("default") is not None:
                extra.append("default: " + json.dumps(s["default"]))
            if s.get("format"):
                extra.append("format: " + s["format"])
            if extra:
                print(f"        \033[2m{'   '.join(extra)}\033[0m")
        return

    payload = parse_tool_args(args, props, tool, server)
    missing = [k for k in schema.get("required", []) if k not in payload]
    if missing:
        die(f"{tool}: missing required flag(s): " + ", ".join("--" + m for m in missing)
            + f"  (see `{server} {tool} --help`)", 2)
    cli = make_client(server)
    async with cli:
        result = await cli.call_tool(tool, payload, raise_on_error=False)
    capture_auth_metadata(server, cli)

    if as_json:
        content = []
        for b in result.content:
            if getattr(b, "type", None) == "text":
                content.append({"type": "text", "text": b.text})
            else:  # image/resource/audio — keep the real fields (data/uri/mimeType), not a repr
                try:
                    content.append(b.model_dump(mode="json"))
                except Exception:
                    content.append({"type": getattr(b, "type", "unknown"), "repr": str(b)})
        env = {"content": content, "isError": result.is_error,
               "structuredContent": result.structured_content}
        print(json.dumps(env, ensure_ascii=False))
    else:
        texts = [b.text for b in result.content if getattr(b, "type", None) == "text"]
        if texts:  # text-first: clean, pure-parseable (e.g. `figma whoami | jq`). Full data via --json.
            print("\n".join(texts))
        else:      # no text (e.g. a screenshot) -> markers so output isn't empty
            for b in result.content:
                print(f"[{getattr(b, 'type', 'content')}]")
    if result.is_error:
        sys.exit(1)


def _store_diagnostic() -> str:
    """sqlite's `unable to open database file` (raised by the DiskStore) names neither the path nor
    the reason, which makes it unactionable. IDE agents (Cursor) run this CLI with a different
    environment than a login shell — measured: a different TZ, and the same command that fails there
    succeeds in a normal terminal — so 'works in my shell' proves nothing. Print what the FAILING
    process itself sees. Best-effort; never raises."""
    out = [f"  store dir : {STORE_DIR}",
           f"  HOME      : {os.environ.get('HOME')}   uid={os.getuid()}   TZ={os.environ.get('TZ', 'unset')}"]
    try:
        out.append(f"  dir       : exists={os.path.isdir(STORE_DIR)} writable={os.access(STORE_DIR, os.W_OK)}")
        db = os.path.join(STORE_DIR, "cache.db")
        out.append(f"  cache.db  : exists={os.path.exists(db)} writable={os.access(db, os.W_OK)}")
        probe = os.path.join(STORE_DIR, f".probe.{os.getpid()}")
        try:  # os.access lies under sandboxes/ACLs — an actual write is the only honest test
            with open(probe, "w"):
                pass
            os.remove(probe)
            out.append("  write test: OK (so the store dir is not the problem)")
        except Exception as e:
            out.append(f"  write test: FAILED ({e})  <-- sandbox or permissions blocking this process")
    except Exception as e:
        out.append(f"  (diagnostic incomplete: {e})")
    return "\n".join(out)


def selfheal() -> None:
    """Error escape hatch: hand the failure to copilot for autonomous repair.

    OPT-IN (`FASTMCP_SELFHEAL=auto`). It used to run on every error, but when copilot itself cannot
    authenticate (its own network failing) it dumps a screenful of unrelated GitHub login errors that
    BURIES the real error — the CLI's job is to report its failure clearly, not to bulldoze it.
    Any other value (e.g. `1`) means "already inside a heal attempt" and suppresses recursion, since
    copilot re-runs this CLI while healing. A missing `copilot` binary degrades silently. The prompt
    tells copilot NOT to touch code on a transient network error (just retry) and only edit for a
    real bug, so a TLS blip never triggers a bad edit."""
    if os.environ.get("FASTMCP_SELFHEAL") != "auto":  # opt-in; also stops heal-inside-heal recursion
        return
    if not shutil.which("copilot"):          # heal is opt-in on copilot being installed
        return
    server = sys.argv[1] if len(sys.argv) > 1 else "?"
    cmd = f"{server} " + " ".join(sys.argv[2:])   # launcher-level command a user would rerun
    tb = traceback.format_exc()
    prompt = f"""The fastmcp CLI `{server}` (script: {__file__}) failed. \
Command to rerun for verification:
    {cmd}

Traceback:
{tb}

Find the ROOT cause, then act by category:
- Transient network/TLS (ConnectError, BrokenResourceError, timeout, handshake, proxy): \
do NOT edit any code — just rerun the exact command above once or twice to confirm it \
self-heals, then report whether it recovered.
- Real config/code bug (bad flag, expired auth, schema drift, logic error): make the \
SMALLEST fix to the script or config, rerun the command to verify, and explain the change.
Keep edits surgical — this is a shared tool script used by many workflows."""
    print("⟳ self-heal: handing error to copilot…", file=sys.stderr)
    env = {**os.environ, "FASTMCP_SELFHEAL": "1"}
    try:
        subprocess.run(
            ["copilot", "-p", prompt, "--model", "gpt-5-mini", "--allow-all-tools",
             "--no-ask-user", "--disable-builtin-mcps", "--no-color"],
            cwd=os.path.dirname(__file__), env=env, timeout=600, check=False)
    except Exception as e:   # heal is best-effort — never mask the original failure
        print(f"self-heal failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:  # never leak a raw traceback to the user
        msg = str(e) or e.__class__.__name__
        print(f"error: {msg}", file=sys.stderr)
        low = msg.lower()
        if "database" in low or "sqlite" in low or "permission" in low or "read-only" in low:
            print("token store could not be opened — what THIS process sees:", file=sys.stderr)
            print(_store_diagnostic(), file=sys.stderr)
            sys.exit(1)  # environment problem — copilot cannot fix a sandbox, so never self-heal it
        selfheal()
        sys.exit(1)
