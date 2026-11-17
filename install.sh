#!/usr/bin/env bash
#
# clawd-monitor-agent installer
#
# One-line installer for the push-based monitoring agent. Designed to be
# served from raw.githubusercontent.com and invoked as:
#
#   curl -fsSL https://raw.githubusercontent.com/LanNguyenSi/clawd-monitor-agent/master/install.sh \
#     | CLAWD_AGENT_TOKEN=<TOKEN> sudo --preserve-env=CLAWD_AGENT_TOKEN bash -s -- \
#         --server wss://clawd-monitor.example
#
# The token is taken from --token-file <path>, else from the CLAWD_AGENT_TOKEN
# environment variable, else from --token (deprecated: the value is visible
# in the process list for as long as the installer runs).
#
# Requires: Debian/Ubuntu, root or sudo, network access to NodeSource
# and npm.
#
# Per the project's "no silent errors" policy: every external command
# that could fail runs without `|| true`, `2>/dev/null`, or any other
# stderr-swallowing pattern. A non-zero exit anywhere kills the run.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PACKAGE_NAME="clawd-monitor-agent"
SERVICE_USER="${CLAWD_INSTALL_SERVICE_USER:-clawd-agent}"
SERVICE_HOME="${CLAWD_INSTALL_SERVICE_HOME:-/var/lib/clawd-agent}"
CONFIG_DIR="${CLAWD_INSTALL_CONFIG_DIR:-/etc/clawd-monitor-agent}"
CONFIG_FILE="$CONFIG_DIR/config.json"
TOKEN_FILE="$CONFIG_DIR/token"
SERVICE_FILE="${CLAWD_INSTALL_SERVICE_FILE:-/etc/systemd/system/clawd-monitor-agent.service}"
SERVICE_NAME="clawd-monitor-agent"
NODE_MAJOR_REQUIRED=18
NODE_MAJOR_INSTALL=20  # NodeSource major to install when a fresh install is needed
VERIFY_TIMEOUT_SECONDS="${CLAWD_INSTALL_VERIFY_TIMEOUT:-15}"

# Test-only escape hatches. These are documented for the vitest suite
# under src/tests/install-sh.test.ts and have no production purpose:
#   CLAWD_INSTALL_SKIP_ROOT_CHECK=1   skip the euid==0 preflight
#   CLAWD_INSTALL_SKIP_USER_CREATE=1  don't useradd / chown to a real user
#   CLAWD_INSTALL_CONFIG_DIR=<path>   override /etc/clawd-monitor-agent
#   CLAWD_INSTALL_SERVICE_FILE=<path> override /etc/systemd/system/...service
#   CLAWD_INSTALL_SERVICE_HOME=<path> override /var/lib/clawd-agent
#   CLAWD_INSTALL_SYSTEMD_PROBE=<dir> override /run/systemd/system probe
#   CLAWD_INSTALL_VERIFY_TIMEOUT=<n>  override the 15 s is-active wait
SKIP_ROOT_CHECK="${CLAWD_INSTALL_SKIP_ROOT_CHECK:-0}"
SKIP_USER_CREATE="${CLAWD_INSTALL_SKIP_USER_CREATE:-0}"
SYSTEMD_PROBE_PATH="${CLAWD_INSTALL_SYSTEMD_PROBE:-/run/systemd/system}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install:warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[install:fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Trap so the user always sees *which* step failed when a command in
# strict mode bombs out.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then printf "\033[1;31m[install:fail]\033[0m installer aborted (exit %d) at line %d: %s\n" "$rc" "$LINENO" "${BASH_COMMAND:-?}" >&2; fi; exit "$rc"' ERR

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

ARG_SERVER=""
ARG_TOKEN=""
ARG_TOKEN_FILE=""
ARG_NAME=""
ARG_GATEWAY=""
ARG_GATEWAY_TOKEN=""
ARG_INTERVAL=""

print_usage() {
  cat <<USAGE
Usage: install.sh --server <url> (--token-file <path> | CLAWD_AGENT_TOKEN=<token>) [options]

Required:
  --server <url>           clawd-monitor server URL (https:// or wss://)

Agent auth token ("+ Add Agent" in the dashboard, or Settings -> Agent Tokens),
from the first of these that is set:
  --token-file <path>      File holding the token (mode 600 recommended)
  CLAWD_AGENT_TOKEN        Environment variable (use sudo --preserve-env=CLAWD_AGENT_TOKEN)
  --token <token>          Deprecated: the value is visible in the process list
                           while the installer runs

Options:
  --name <name>            Display name in the dashboard (default: hostname)
  --gateway <url>          OpenClaw gateway URL (default: http://localhost:18789)
  --gateway-token <token>  OpenClaw gateway auth token
  --interval <ms>          Snapshot push interval in ms, a whole number (default: 5000, min: 1000, max: 2147483647)
  -h, --help               Show this help

Re-running the installer with the same args is a no-op restart.
Re-running with a different token rotates the token cleanly.
USAGE
}

# A value flag needs a following, non-empty argument; without one `shift 2`
# would abort through the ERR trap instead of printing a usage error.
need_value() {
  [ "$2" -ge 2 ] || fail "$1 needs a value"
  [ -n "$3" ] || fail "$1 needs a value (got an empty string)"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)         need_value "$1" "$#" "${2:-}"; ARG_SERVER="$2";         shift 2 ;;
    --token)          need_value "$1" "$#" "${2:-}"; ARG_TOKEN="$2";          shift 2 ;;
    --token-file)     need_value "$1" "$#" "${2:-}"; ARG_TOKEN_FILE="$2";     shift 2 ;;
    --name)           need_value "$1" "$#" "${2:-}"; ARG_NAME="$2";           shift 2 ;;
    --gateway)        need_value "$1" "$#" "${2:-}"; ARG_GATEWAY="$2";        shift 2 ;;
    --gateway-token)  need_value "$1" "$#" "${2:-}"; ARG_GATEWAY_TOKEN="$2";  shift 2 ;;
    --interval)       need_value "$1" "$#" "${2:-}"; ARG_INTERVAL="$2";       shift 2 ;;
    -h|--help)        print_usage; exit 0 ;;
    *)                fail "unknown argument: $1 (run with --help)" ;;
  esac
done

[ -n "$ARG_SERVER" ] || { print_usage >&2; fail "--server is required"; }

# Token input. Precedence, highest first: --token-file, the CLAWD_AGENT_TOKEN
# environment variable, --token. A set but empty (or whitespace-only)
# environment variable counts as unset; an empty or unreadable token file is
# an error. The variable is unset right away so that npm, apt and curl and
# everything they start never inherit it.
trim_ws() {
  local v=$1
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}

ENV_TOKEN="$(trim_ws "${CLAWD_AGENT_TOKEN:-}")"
unset CLAWD_AGENT_TOKEN

if [ -n "$ARG_TOKEN" ]; then
  warn "--token is deprecated: the value is visible in the process list while the installer runs. Use --token-file <path> or the CLAWD_AGENT_TOKEN environment variable."
fi

AGENT_TOKEN=""
if [ -n "$ARG_TOKEN_FILE" ]; then
  [ -f "$ARG_TOKEN_FILE" ] && [ -r "$ARG_TOKEN_FILE" ] || fail "--token-file $ARG_TOKEN_FILE is not a readable file"
  AGENT_TOKEN="$(trim_ws "$(head -n 1 "$ARG_TOKEN_FILE")")"
  [ -n "$AGENT_TOKEN" ] || fail "--token-file $ARG_TOKEN_FILE is empty"
elif [ -n "$ENV_TOKEN" ]; then
  AGENT_TOKEN="$ENV_TOKEN"
elif [ -n "$ARG_TOKEN" ]; then
  AGENT_TOKEN="$ARG_TOKEN"
else
  print_usage >&2
  fail "an agent token is required: use --token-file <path>, the CLAWD_AGENT_TOKEN environment variable, or --token"
fi
ENV_TOKEN=""

# Validate --interval before writing it with printf %d: a whole number of ms,
# at most 2147483647, like the agent's own start-up check (src/config.ts),
# which also refuses larger values (setInterval treats larger
# delays as 1 ms); values below 1000 are raised to 1000. Leading zeros are
# stripped before comparing, and more than 10 digits is too large without
# relying on shell integer arithmetic.
if [ -n "$ARG_INTERVAL" ]; then
  case "$ARG_INTERVAL" in
    *[!0-9]*) fail "--interval must be a whole number of ms between 1000 and 2147483647 (got: $ARG_INTERVAL)" ;;
  esac
  interval_digits="${ARG_INTERVAL#"${ARG_INTERVAL%%[!0]*}"}"
  if [ "${#interval_digits}" -gt 10 ] || { [ -n "$interval_digits" ] && [ "$interval_digits" -gt 2147483647 ]; }; then
    fail "--interval must be a whole number of ms between 1000 and 2147483647 (got: $ARG_INTERVAL)"
  fi
  if [ -z "$interval_digits" ] || [ "$interval_digits" -lt 1000 ]; then
    warn "--interval $ARG_INTERVAL is below the minimum, using 1000"
    interval_digits=1000
  fi
  ARG_INTERVAL="$interval_digits"
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [ "$SKIP_ROOT_CHECK" != "1" ]; then
  [ "$(id -u)" -eq 0 ] || fail "must run as root (try: sudo bash install.sh ...)"
fi
[ "$(uname -s)" = "Linux" ] || fail "only Linux is supported"

if [ ! -d "$SYSTEMD_PROBE_PATH" ]; then
  fail "systemd not detected — only systemd-based distros (Debian, Ubuntu, etc.) are supported"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  fail "apt-get not found — only Debian/Ubuntu are supported by this installer"
fi

# ---------------------------------------------------------------------------
# Node 18+ install
# ---------------------------------------------------------------------------

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$current_major" -ge "$NODE_MAJOR_REQUIRED" ]; then
      log "node $(node --version) already installed"
      return 0
    fi
    warn "node $(node --version) is older than required v${NODE_MAJOR_REQUIRED}; upgrading"
  else
    log "node not found; installing via NodeSource"
  fi

  log "fetching NodeSource setup script for Node ${NODE_MAJOR_INSTALL}.x"
  # NodeSource's setup script handles apt source + key install. It is loud
  # by design; we let it speak so any failure is visible. Piping curl
  # straight into bash inherits our errexit via the bash subshell exit
  # code.
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_INSTALL}.x" | bash -

  log "apt-get install nodejs"
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

  log "node $(node --version) installed"
}

ensure_node

# A token file that other users can read exposes the token to them. The
# installer only reads it (as root), so this is a warning, not an error.
if [ -n "$ARG_TOKEN_FILE" ]; then
  token_file_mode=$(stat -c %a "$ARG_TOKEN_FILE")
  case "$token_file_mode" in
    *[1-7]) warn "--token-file $ARG_TOKEN_FILE is accessible to other users (mode $token_file_mode); remove the file after the install or use mode 600" ;;
  esac
fi

# ---------------------------------------------------------------------------
# npm package
# ---------------------------------------------------------------------------

install_package() {
  log "npm install -g ${PACKAGE_NAME}"
  npm install -g --no-audit --no-fund "$PACKAGE_NAME"

  if ! command -v "$PACKAGE_NAME" >/dev/null 2>&1; then
    fail "$PACKAGE_NAME binary not found on PATH after install"
  fi
  local resolved_bin
  resolved_bin=$(command -v "$PACKAGE_NAME")
  log "${PACKAGE_NAME} → ${resolved_bin}"
}

install_package

# An agent older than the --token-file flag cannot read the token from its own
# file. The installer is served from master while the npm package is released
# separately, so check what was actually installed and fall back to the
# previous layout (token inside config.json) for an agent that lacks the flag.
detect_token_layout() {
  local agent_bin help_text
  agent_bin=$(command -v "$PACKAGE_NAME")
  help_text=$("$agent_bin" --help)
  case "$help_text" in
    *--token-file*) TOKEN_LAYOUT="file" ;;
    *)
      TOKEN_LAYOUT="config"
      warn "the installed ${PACKAGE_NAME} does not support --token-file yet; storing the token in ${CONFIG_FILE} (mode 0640) instead"
      ;;
  esac
}

detect_token_layout

# ---------------------------------------------------------------------------
# Service user + directories
# ---------------------------------------------------------------------------

ensure_service_user() {
  if [ "$SKIP_USER_CREATE" = "1" ]; then
    log "test mode: skipping user create + ownership chown for '${SERVICE_USER}'"
    install -d -m 0755 "$SERVICE_HOME"
    install -d -m 0750 "$CONFIG_DIR"
    return 0
  fi

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "user '${SERVICE_USER}' already exists"
  else
    log "creating system user '${SERVICE_USER}' (home: ${SERVICE_HOME})"
    useradd --system --home-dir "$SERVICE_HOME" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi

  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME"
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

  # Best-effort: if the host has a docker group, add the service user
  # so the docker collector can call `docker ps` without sudo. This is
  # a soft requirement — the docker collector tolerates failure.
  if getent group docker >/dev/null 2>&1; then
    if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
      log "service user already in 'docker' group"
    else
      log "adding '${SERVICE_USER}' to 'docker' group"
      usermod -aG docker "$SERVICE_USER"
    fi
  fi
}

ensure_service_user

# ---------------------------------------------------------------------------
# Config (token NEVER echoed beyond this point)
# ---------------------------------------------------------------------------

# Resolve dynamic defaults *before* we go silent on the token. The token
# itself is written to a tempfile with printf (a builtin, so no argv) and
# mv'd into place; after argument parsing we never echo $AGENT_TOKEN, never
# pass it on a command line that ps(1) could expose, and never put it in
# `set -x` output. The installer's own argv carries it only when the
# deprecated --token flag was used.

CONFIG_NAME="${ARG_NAME:-$(hostname)}"
CONFIG_GATEWAY="${ARG_GATEWAY:-http://localhost:18789}"
CONFIG_INTERVAL="${ARG_INTERVAL:-5000}"

# Minimal JSON string escaper for shell-substituted values. We don't
# embed structured data — only flat strings — so this is enough for
# correctness AND it keeps us from depending on `jq` being installed.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}

write_config() {
  log "writing config → ${CONFIG_FILE} (mode 0640, owned by root:${SERVICE_USER})"

  # Defensive: ensure CONFIG_DIR exists with the right permissions even
  # if a future refactor changes the order of ensure_service_user vs
  # write_config. Cheap, safe, idempotent.
  install -d -m 0750 "$CONFIG_DIR"

  local tmpfile
  tmpfile=$(mktemp "${CONFIG_DIR}/config.json.XXXXXX")
  # Clean up the tmpfile if anything in this function fails before the
  # final mv. Without this, a partial write (disk full, signal) leaves
  # a stale config.json.XXXXXX in /etc/clawd-monitor-agent/.
  trap 'rm -f "$tmpfile"' RETURN

  # Tighten the tmpfile up front so the token is never world-readable
  # even for the milliseconds before the final chmod/chown.
  chmod 0640 "$tmpfile"
  if [ "$SKIP_USER_CREATE" != "1" ]; then
    chown "root:${SERVICE_USER}" "$tmpfile"
  fi

  # heredoc keeps the token out of argv. The JSON shape matches what
  # `loadConfig` (src/config.ts) accepts under --config.
  {
    printf '{\n'
    printf '  "server": %s,\n'           "$(json_escape "$ARG_SERVER")"
    if [ "$TOKEN_LAYOUT" = "config" ]; then
      printf '  "token": %s,\n'          "$(json_escape "$AGENT_TOKEN")"
    fi
    printf '  "name": %s,\n'             "$(json_escape "$CONFIG_NAME")"
    printf '  "intervalMs": %d,\n'       "$CONFIG_INTERVAL"
    printf '  "gateway": {\n'
    printf '    "url": %s'               "$(json_escape "$CONFIG_GATEWAY")"
    if [ -n "$ARG_GATEWAY_TOKEN" ]; then
      printf ',\n    "token": %s\n'      "$(json_escape "$ARG_GATEWAY_TOKEN")"
    else
      printf '\n'
    fi
    printf '  }\n'
    printf '}\n'
  } > "$tmpfile"

  mv -f "$tmpfile" "$CONFIG_FILE"
}

# The token lives in its own file, mode 0600 and owned by the service user,
# and the unit points the agent at it with --token-file. config.json then holds
# no secret except an optional gateway token.
write_token_file() {
  if [ "$TOKEN_LAYOUT" != "file" ]; then
    # A file left by an earlier install must not outlive a fallback to the
    # old layout: it would hold a token that is no longer rotated.
    rm -f "$TOKEN_FILE"
    return 0
  fi

  log "writing token → ${TOKEN_FILE} (mode 0600, owned by ${SERVICE_USER})"
  local tmpfile
  tmpfile=$(mktemp "${CONFIG_DIR}/token.XXXXXX")
  trap 'rm -f "$tmpfile"' RETURN

  chmod 0600 "$tmpfile"
  if [ "$SKIP_USER_CREATE" != "1" ]; then
    chown "${SERVICE_USER}:${SERVICE_USER}" "$tmpfile"
  fi
  printf '%s\n' "$AGENT_TOKEN" > "$tmpfile"
  mv -f "$tmpfile" "$TOKEN_FILE"
}

# ---------------------------------------------------------------------------
# systemd unit
# ---------------------------------------------------------------------------

write_unit() {
  log "writing systemd unit → ${SERVICE_FILE}"
  local agent_bin
  agent_bin=$(command -v "$PACKAGE_NAME")

  # NOTE: the token is NOT in this unit, only the path of the file that
  # holds it (mode 0600, owned by the service user). With an agent that
  # predates --token-file it is in the config file instead (mode 0640,
  # root:clawd-agent). systemctl status / cat can be run by any local user
  # without exposing the token.
  local exec_args="--config ${CONFIG_FILE}"
  if [ "$TOKEN_LAYOUT" = "file" ]; then
    exec_args="${exec_args} --token-file ${TOKEN_FILE}"
  fi
  cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=clawd-monitor agent (push-based monitoring)
Documentation=https://github.com/LanNguyenSi/clawd-monitor-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=HOME=${SERVICE_HOME}
ExecStart=${agent_bin} ${exec_args}
Restart=always
RestartSec=10
# Hardening: the agent only needs to read /proc, run docker via the
# socket (group-gated), and reach the network. Lock down the rest.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SERVICE_HOME}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 "$SERVICE_FILE"
}

# Order matters: a failure between two of these steps must leave a host that
# still boots. With --token-file the token file comes first, then the unit that
# reads it, and config.json (which no longer holds the token) last: the old unit
# with the old config, and the new unit with the old config, both start. With
# the older agent the config (which holds the token) comes first, then the
# unit, and the token file of an earlier install is removed last.
if [ "$TOKEN_LAYOUT" = "file" ]; then
  write_token_file
  write_unit
  write_config
else
  write_config
  write_unit
  write_token_file
fi

# ---------------------------------------------------------------------------
# Activate
# ---------------------------------------------------------------------------

log "systemctl daemon-reload"
systemctl daemon-reload

log "systemctl enable --now ${SERVICE_NAME}"
# `restart` (not just `start`) so a re-run with a rotated token actually
# picks the new config up.
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

log "waiting up to ${VERIFY_TIMEOUT_SECONDS}s for the unit to report active…"
deadline=$(( $(date +%s) + VERIFY_TIMEOUT_SECONDS ))
while :; do
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    warn "unit did not reach 'active' within ${VERIFY_TIMEOUT_SECONDS}s; recent logs:"
    # Loud on purpose: if journalctl itself fails, the trap fires and
    # the operator sees the failure rather than a "no logs found"
    # silent success.
    journalctl -u "$SERVICE_NAME" --since "2 minutes ago" --no-pager -n 50 >&2
    fail "service '${SERVICE_NAME}' failed to start (check 'systemctl status ${SERVICE_NAME}')"
  fi
  sleep 1
done

# Surface auth-level failures early. The agent prints these on the
# corresponding code paths (see src/agent.ts):
#   - on success: nothing distinctive in stderr — auth_ok is silent
#   - on bad token:  '[clawd-agent][ERROR] Authentication failed: …'
#   - on protocol:   the message type 'auth_error' may also appear
# Match both the human-readable log line and the wire-level type. We
# do NOT grep for 'forbidden' / '401' / '403' because the agent never
# emits those literals and they show up in unrelated systemd noise.
log "checking recent logs for auth errors"
recent_logs=$(journalctl -u "$SERVICE_NAME" --since "2 minutes ago" --no-pager -n 100)
if printf '%s\n' "$recent_logs" | grep -qE 'Authentication failed|auth_error'; then
  warn "auth error detected in recent logs:"
  printf '%s\n' "$recent_logs" | tail -n 20 >&2
  fail "agent reported an auth error — verify the token matches one in the dashboard"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

if [ "$TOKEN_LAYOUT" = "file" ]; then
  TOKEN_DESCRIPTION="$TOKEN_FILE  (mode 0600, ${SERVICE_USER})"
else
  TOKEN_DESCRIPTION="inside the config file (older agent without --token-file)"
fi

cat <<DONE

[install] ✓ clawd-monitor-agent installed and running

  Service:  $SERVICE_NAME
  Status:   active (verified above)
  Config:   $CONFIG_FILE  (mode 0640, root:${SERVICE_USER})
  Token:    $TOKEN_DESCRIPTION
  Unit:     $SERVICE_FILE
  Logs:     journalctl -u ${SERVICE_NAME} -f

The agent is pushing snapshots to ${ARG_SERVER}. Watch the dashboard
for the host to come online — it usually takes a few seconds once
the connection is established.
DONE
