typeset -g PASEO_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${PASEO_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${PASEO_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

# User .zshenv may rewrite PATH. Re-assert Paseo-managed MCP CLI bin so
# `figma` / `atlassian` stay resolvable after login shells bootstrap.
if [[ -n "${PASEO_MCP_CLI_BIN-}" && -d "${PASEO_MCP_CLI_BIN}" ]]; then
  path=("${PASEO_MCP_CLI_BIN}" ${path:#${PASEO_MCP_CLI_BIN}})
  export PATH
fi

source "${PASEO_SHELL_INTEGRATION_DIR}/paseo-integration.zsh"
