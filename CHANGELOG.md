# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `--token-file=/path` and `--gateway-token-file=/path` now parse exactly like the space-separated form. The equals form used to fall through to the generic argument handling: the value was stored under a key no token source reads (or dropped when the flag was the last argument), so the agent silently used the next token source (environment variable, deprecated flag or config file). The path may itself contain `=`. An empty value (`--token-file=` or `--gateway-token-file=`) is refused with `<flag> needs a path` on stderr and exit code 1, like the space form.

## [0.4.0] - 2026-11-17

### Security

- **The agent token no longer has to be on a command line.** A token passed as `--token <value>` stays in `ps` and `/proc/<pid>/cmdline` for as long as the process runs, so any local user on the host could read it and connect as the agent. The agent now also reads the token from `--token-file <path>` (a file other users cannot read: mode 0640 gives a warning, any "other" access is refused) and from the `CLAWD_AGENT_TOKEN` environment variable, which it removes from its own environment after reading so the `docker` and `openclaw` children do not inherit it. Precedence: `--token-file`, then the variable, then `--token`, then `token` in the `--config` file. `--token` still works and prints a deprecation warning on stderr. `install.sh` takes the token from `--token-file`, `CLAWD_AGENT_TOKEN` (unset before npm and apt start) or the now deprecated `--token`, writes it to `/etc/clawd-monitor-agent/token` (mode 0600, owned by `clawd-agent`) and starts the agent with `--token-file`; `config.json` no longer holds the token. If the installed agent predates `--token-file`, the installer keeps the previous layout (token in `config.json`). Existing installs keep working unchanged; the README has the steps to move a host that uses `--token` to the file without changing the token. An empty `--token ""` used to win over the config file and fail; it now counts as unset.

- **The OpenClaw Gateway token no longer has to be on a command line either.** `--gateway-token <value>` stays in `ps` and `/proc/<pid>/cmdline` for as long as the agent runs, like `--token` did. The agent now also reads the Gateway token from `--gateway-token-file <path>` (same mode check as `--token-file`: any "other" access is refused, group-only access warns, a FIFO, directory or empty file is an error) and from the `OPENCLAW_GATEWAY_TOKEN` environment variable. Precedence for the collectors: `--gateway-token-file`, then the variable, then `--gateway-token`, then `gateway.token` in the `--config` file. `--gateway-token` still works and prints a deprecation warning on stderr; an empty `--gateway-token ""` now counts as unset instead of hiding the variable. What is sent to the dashboard in the `auth` message is unchanged: the file, flag or config token, never the variable. The agent leaves `OPENCLAW_GATEWAY_TOKEN` in its environment because the `openclaw` CLI it falls back to reads it, but its own Gateway calls now use the resolved value and no longer read the variable. `install.sh` takes `--gateway-token-file <path>` (or the deprecated `--gateway-token`), writes the token to `/etc/clawd-monitor-agent/gateway-token` (mode 0600, owned by `clawd-agent`) and starts the agent with `--gateway-token-file`; `config.json` no longer holds it. If the installed agent predates `--gateway-token-file`, the installer keeps the token in `config.json` as before. Existing installs keep working unchanged; re-run the installer with `--gateway-token-file` to move the token out of `config.json` (README and `docs/cli-reference.md` have the upgrade note). A collector run with both the variable and a different `--gateway-token` or `gateway.token` now uses the variable. Also: a token file that is a FIFO is refused ("not a regular file") instead of hanging the start-up, and the installer moves its files into place with `mv -fT` (a token path that is a symlink to a directory is replaced, not moved into) and writes the unit through a temporary file, so a failed run leaves the previous unit intact.

- **`--token-file` or `--gateway-token-file` without a value now fails fast.** Used to be dropped silently (as the last argument, or followed by another flag), so the agent fell through to the next token source (environment variable, deprecated flag or config file). The agent now prints `<flag> needs a path` on stderr and exits with code 1; an empty value (`--token-file ""`) is refused the same way, and so is `--token-file --help` (the flag still needs its path before any other flag).

### Changed

- Dependency updates: `renovate.json` extends the shared `github>LanNguyenSi/renovate-config` preset (weekly grouped patch/minor pull requests, 7-day minimum release age, no automerge, majors only through the Dependency Dashboard).

## [0.3.0] - 2026-10-25

### Changed

- **A non-numeric `--interval` or `intervalMs`, or one above 2147483647 ms, is now rejected.** The agent prints an error and exits with code 1 instead of pushing continuously (`abc`) or silently using 1000 (`5s`). An existing install whose config file has a malformed `intervalMs` refuses to start until it is fixed.
- The Docker `restarts` field now holds the real restart count from one batched `docker inspect` call. It was the exit code from the `docker ps` status column. A container whose count inspect does not return (it vanished, or inspect failed) has no `restarts` field. The `uptime` field is documented as the time since creation.

### Fixed

- `install.sh --interval` now accepts only a whole number of ms up to 2147483647 and otherwise exits 1 with an error naming the bounds, and raises a value below 1000 to 1000 with a warning. The agent itself refuses non-numeric and too-large values at start-up; the installer also refuses decimals because it writes the value as an integer. An install no longer writes a config that stops the agent from starting (task 1ecec58b).
- `install.sh` now exits 1 with `<flag> needs a value` when a value flag (`--server`, `--token`, `--name`, `--gateway`, `--gateway-token`, `--interval`) has no following argument or an empty one, instead of aborting through the ERR trap or silently using the default.
- The Docker collector runs `docker inspect --type container`, so an id prefix can no longer resolve a non-container object.
- A server `error` reply is logged at error level; one received before `auth_ok` is treated as a failed auth (the agent stops instead of staying connected and silent).
- A trailing slash on `--server` no longer produces `wss://host//api/agents/ws`.

## [0.2.0] - 2026-10-09

Support for OpenClaw 2026.9: sessions moved to SQLite, so the JSONL reader no longer finds them.

### Fixed

- **Sessions are visible again on OpenClaw 2026.9+.** The agent used to read `~/.openclaw/agents/main/sessions/*.jsonl`, which is empty there. The old reader stays as the last fallback for older releases.
- Session objects carry `status` and `totalTokens`; cron jobs carry `status`, `lastRunStatus` and `lastError`, so the dashboard shows the real state of skipped or failing jobs.
- The cron collector no longer blocks the event loop and no longer times out after 10 s: the OpenClaw CLI takes about 3 s to start, so it runs asynchronously with a 45 s budget, and log lines before the JSON output are tolerated.
- CLI-backed collectors share one in-flight call and cache their result (sessions 30 s, cron 60 s, failures 10 s), so slow CLI starts no longer overlap and saturate the host at a 5 s push interval.

### Changed

- **Sessions and cron jobs are read from the local OpenClaw Gateway over WebSocket** (`sessions.list`, one bulk `sessions.preview`, `cron.list`; operator `read` scope only) instead of spawning the `openclaw` CLI. A call takes tens of milliseconds instead of `3 s of CPU. This needs a Gateway token: `gateway.token` in the config, or the `OPENCLAW_GATEWAY_TOKEN` environment variable (preferred: unlike `gateway.token` it is **not** forwarded to the dashboard server). Without a token, or if the Gateway is unreachable, the agent falls back to the cached CLI path and then to the legacy JSONL reader.

## [0.1.1] - 2026-10-05

### Fixed

- The WebSocket `auth` message now reports the package version
  (read from `package.json`) instead of a hardcoded `1.0.0`, so the
  dashboard shows the real agent version.
- The default agent name now comes from `os.hostname()` instead of
  reading `/etc/hostname`, so it is correct on hosts without that file
  (macOS, Windows), matching the CLI help. An agent without an explicit
  name may appear under a different dashboard name where `os.hostname()`
  differs from `/etc/hostname`; set `name` in the config or pass `--name`
  to keep the old one.
- An `intervalMs` read from the config file is now clamped to the 1000 ms
  minimum, the same as `--interval`; before, a smaller config value was
  used as is, so a config with a smaller value now pushes every 1000 ms.
- The installer's `--help` text now states the 1000 ms interval minimum
  and where agent tokens are created in the dashboard.

### Changed

- The publish workflow now installs npm with `npm install -g npm@^11.5.1` (the documented trusted-publishing floor) instead of the floating `npm@11`, and the publish step's two success-on-registry exits (the "already on the registry" idempotency check before the retry loop and the loop's "reached the registry despite a non-zero publish exit" branch) now probe `npm view <pkg>@<version> dist.attestations` and fail with an error when the attestation is empty (or when the probe itself fails), so a partially completed publish is no longer announced green. CI only; no package code change.

## [0.1.0] - 2026-04-26

First public release. Pre-1.0: the WebSocket protocol and config
shape are not yet stable; minor versions may break compatibility
until v1.0.0.

### Added

- One-line installer script (`install.sh`) for fresh Debian / Ubuntu
  hosts. Installs Node 18+ via NodeSource if needed, the npm package,
  a dedicated `clawd-agent` system user, and a hardened systemd unit.
  Verifies the service reaches `active` within 15 s and grep-checks
  the unit's recent journal for `Authentication failed` / `auth_error`
  patterns so a bad-token install fails loud rather than appearing
  successful (PR #11).
- The companion clawd-monitor dashboard's "Add Agent" modal now
  renders a paste-ready `curl … | sudo bash` snippet referencing the
  installer.
- Snapshots include yesterday's daily memory log in addition to
  today's, so the dashboard's memory viewer never goes blank just
  after midnight (PR #8).
- `recentMessages` (last 5 per session, truncated) embedded directly
  in each session snapshot — eliminates a follow-up gateway round-trip
  from the dashboard.

### Changed

- Cron-jobs collector switched from a (broken) HTTP gateway path to
  the `openclaw` CLI (PR #7).
- The agent identifies itself with a single VERSION constant sourced
  from `package.json`. Previously `1.0.0` was hardcoded in two places
  (`src/cli.ts`, `src/collectors/index.ts`) and could drift silently.
- WebSocket reconnect cascade fix: the agent no longer terminates an
  in-flight connection while opening a new one in the same event
  loop tick (PR #9).
- Sessions collector reads the correct local JSONL path layout and
  parses the `type+message` JSONL shape correctly.
- Auth handshake now includes `gatewayUrl` and `gatewayToken` so the
  dashboard can proxy gateway calls through the active agent (PR #3).

### Fixed

- `Session.key` renamed to `sessionKey` for compatibility with the
  dashboard's snapshot schema.
- High-severity transitive CVEs patched: `vitest 1.x → 4.1.2`
  (esbuild), `follow-redirects` bumps (PR #5, PR #10).

### Notes

- This is the agent's first git tag. The pre-OS-prep development
  history under `package.json: 1.0.0` was internal; `0.1.0` is the
  first version published to npm.
