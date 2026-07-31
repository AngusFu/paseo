# paseo markdown

Markdown archive → styled standalone HTML preview.

Primary entrypoint:

```bash
paseo markdown <file.md>                 # render + open
paseo markdown <file.md> --print         # print path only
paseo markdown <file.md> --stdout        # html on stdout
paseo markdown <file.md> --out x.html    # explicit path
paseo markdown <file.md> --no-cache      # temp file, skip stable cache
paseo markdown <file.md> --clear         # drop that file's cache entry
paseo markdown --clear-all               # wipe the cache dir
paseo markdown --cache-dir               # print cache directory
paseo markdown --ls-cache                # list cached html files
paseo markdown --serve [--port 4490]     # localhost render server
```

Implementation: `render.py` (PEP 723 deps via `uv`). Requires `uv` on PATH.

## Cache

Default output: `$TMPDIR/paseo-markdown/<stem>-<hash>.html` (system temp — OS may purge on reboot / tmp GC).

- Every render rewrites the file for that source path (not a content-hash cache).
- HTML is never written next to the `.md` unless you pass `--out`.
- `--no-cache` uses a unique `mkstemp` file (also under the system temp dir).
- Override with `PASEO_MARKDOWN_CACHE` only if you intentionally want a sticky location.

## Env

| var                              | default                                  |
| -------------------------------- | ---------------------------------------- |
| `PASEO_MARKDOWN_CACHE`           | `$TMPDIR/paseo-markdown`                 |
| `PASEO_MARKDOWN_PORT`            | `4490`                                   |
| `PASEO_MARKDOWN_JIRA_BROWSE`     | `https://mdpi.atlassian.net/browse/`     |
| `PASEO_MARKDOWN_GITLAB_WEB`      | `https://gitlab.mdpi.com:8081`           |
| `PASEO_MARKDOWN_FRAME_ANCESTORS` | `'none'`                                 |
| `PASEO_MARKDOWN_ROOTS`           | launch CWD + cache dir (serve allowlist) |

`REPORT_HTML_*` names remain accepted as COMPAT fallbacks.

## Dev

```bash
make test
make smoke
make serve
```
