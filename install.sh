#!/usr/bin/env bash
#
# clawd-monitor-agent installer
#
# One-line installer for the push-based monitoring agent. Designed to be
# served from raw.githubusercontent.com and invoked as:
#
#   curl -fsSL https://raw.githubusercontent.com/LanNguyenSi/clawd-monitor-agent/master/install.sh \
#     | sudo bash -s -- --server wss://clawd-monitor.example --token <TOKEN>
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
ARG_NAME=""
ARG_GATEWAY=""
ARG_GATEWAY_TOKEN=""
ARG_INTERVAL=""

print_usage() {
  cat <<USAGE
Usage: install.sh --server <url> --token <token> [options]

Required:
  --server <url>           clawd-monitor server URL (https:// or wss://)
  --token <token>          Agent auth token (created via Add Agent in the dashboard)

Options:
  --name <name>            Display name in the dashboard (default: hostname)
  --gateway <url>          OpenClaw gateway URL (default: http://localhost:18789)
  --gateway-token <token>  OpenClaw gateway auth token
  --interval <ms>          Snapshot push interval in ms (default: 5000)
  -h, --help               Show this help

Re-running the installer with the same args is a no-op restart.
Re-running with a different --token rotates the token cleanly.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)         ARG_SERVER="${2:-}";          shift 2 ;;
    --token)          ARG_TOKEN="${2:-}";           shift 2 ;;
    --name)           ARG_NAME="${2:-}";            shift 2 ;;
    --gateway)        ARG_GATEWAY="${2:-}";         shift 2 ;;
    --gateway-token)  ARG_GATEWAY_TOKEN="${2:-}";   shift 2 ;;
    --interval)       ARG_INTERVAL="${2:-}";        shift 2 ;;
    -h|--help)        print_usage; exit 0 ;;
    *)                fail "unknown argument: $1 (run with --help)" ;;
  esac
done

[ -n "$ARG_SERVER" ] || { print_usage >&2; fail "--server is required"; }
[ -n "$ARG_TOKEN" ]  || { print_usage >&2; fail "--token is required"; }

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
# itself is written to a tempfile via a heredoc and mv'd into place;
# we never echo $ARG_TOKEN, never pass it on a command line that ps(1)
# could expose, and never put it in `set -x` output.

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
    printf '  "token": %s,\n'            "$(json_escape "$ARG_TOKEN")"
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

write_config

# ---------------------------------------------------------------------------
# systemd unit
# ---------------------------------------------------------------------------

write_unit() {
  log "writing systemd unit → ${SERVICE_FILE}"
  local agent_bin
  agent_bin=$(command -v "$PACKAGE_NAME")

  # NOTE: token is NOT in this unit. The agent reads it from the config
  # file (which is mode 0640, root:clawd-agent). systemctl status / cat
  # can be run by any local user without exposing the token.
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
ExecStart=${agent_bin} --config ${CONFIG_FILE}
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

write_unit

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
  fail "agent reported an auth error — verify --token matches a token in the dashboard"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

cat <<DONE

[install] ✓ clawd-monitor-agent installed and running

  Service:  $SERVICE_NAME
  Status:   active (verified above)
  Config:   $CONFIG_FILE  (mode 0640, root:${SERVICE_USER})
  Unit:     $SERVICE_FILE
  Logs:     journalctl -u ${SERVICE_NAME} -f

The agent is pushing snapshots to ${ARG_SERVER}. Watch the dashboard
for the host to come online — it usually takes a few seconds once
the connection is established.
DONE
