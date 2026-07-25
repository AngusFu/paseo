if [[ -n "${_PASEO_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _PASEO_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _PASEO_ZSH_COMMAND_ACTIVE=0

function _paseo_ensure_mcp_cli_path() {
  # User .zshrc / mise / asdf often rewrite PATH after .zshenv. Keep
  # Paseo-managed FastMCP CLIs first when the daemon marked the bin dir.
  if [[ -n "${PASEO_MCP_CLI_BIN-}" && -d "${PASEO_MCP_CLI_BIN}" ]]; then
    path=("${PASEO_MCP_CLI_BIN}" ${path:#${PASEO_MCP_CLI_BIN}})
    export PATH
  fi
}

function _paseo_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _paseo_precmd() {
  local command_status=$?
  _paseo_ensure_mcp_cli_path
  if [[ "$_PASEO_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _paseo_osc633 "D;${command_status}"
    _PASEO_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _paseo_osc633 "A"
}

function _paseo_preexec() {
  _PASEO_ZSH_COMMAND_ACTIVE=1
  _paseo_osc633 "B"
  _paseo_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _paseo_precmd
add-zsh-hook preexec _paseo_preexec

# .zshrc has not run yet when this file is sourced from our ZDOTDIR .zshenv.
# Schedule one early re-assert for interactive shells once startup finishes.
_paseo_ensure_mcp_cli_path
