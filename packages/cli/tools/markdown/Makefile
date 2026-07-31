# paseo markdown — standalone. Deps come from render.py's PEP-723 header via uv.
# Primary entrypoint is `paseo markdown` (Node CLI wrapper in packages/cli).
UV ?= $(shell command -v uv 2>/dev/null || echo $$HOME/.local/bin/uv)
DEPS := --with markdown --with pygments --with bleach --with pyyaml
RUN := $(UV) run --no-project --python 3.12 $(DEPS) --

.PHONY: test serve smoke help

help:
	@echo "make test   — unit tests (no network, no browser)"
	@echo "make serve  — render server on :$${PASEO_MARKDOWN_PORT:-4490}"
	@echo "make smoke  — render the sample doc to stdout, grep key features"
	@echo "primary CLI: paseo markdown <file.md>"

test:
	$(RUN) python -m unittest discover -s tests -t . -v

serve:
	$(RUN) python render.py --serve

smoke:
	$(RUN) python render.py tests/fixtures/sample.md --stdout \
	  | grep -q 'class="hl"' && echo "ok: pygments"
	$(RUN) python render.py tests/fixtures/sample.md --stdout \
	  | grep -q 'nav class="toc"' && echo "ok: toc"
	$(RUN) python render.py tests/fixtures/sample.md --stdout \
	  | grep -q 'class="fm-todos"' && echo "ok: todos"
	$(RUN) python render.py tests/fixtures/sample.md --stdout \
	  | grep -q 'class="fm-meta"' && echo "ok: meta"
