# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
