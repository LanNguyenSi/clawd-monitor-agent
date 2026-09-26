# clawd-monitor-agent

[![CI](https://github.com/LanNguyenSi/clawd-monitor-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/LanNguyenSi/clawd-monitor-agent/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/clawd-monitor-agent)](https://www.npmjs.com/package/clawd-monitor-agent)

Push-based monitoring agent for [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor).

## Overview

Runs on each OpenClaw host, connects outbound to a central clawd-monitor
dashboard, and pushes live snapshots every 5 seconds; no inbound ports
required on the agent host. It collects session, cron, system-metrics,
memory-file, and Docker data and streams it over a single WebSocket
connection that reconnects with backoff if the dashboard is unreachable.

## Key features

- Active OpenClaw sessions, read from local JSONL files
- Scheduled cron jobs with next/last run times
- CPU and RAM metrics via `/proc`
- Memory files: `MEMORY.md`, `CURRENT.md`, today's and yesterday's daily log
- Docker containers (running/stopped), state, uptime, restarts
- Last 5 messages per session, embedded in the snapshot
- Single outbound WebSocket, no inbound ports on the agent host

## Quick start

Requires Node.js 18+ (installer handles this on Debian/Ubuntu).

```bash
curl -fsSL https://raw.githubusercontent.com/LanNguyenSi/clawd-monitor-agent/master/install.sh \
  | sudo bash -s -- \
      --server wss://your-clawd-monitor-domain \
      --token <agent-token-from-settings>
```

Installs Node 18+ (via NodeSource if needed), the `clawd-monitor-agent`
npm package, a dedicated `clawd-agent` system user, a config at
`/etc/clawd-monitor-agent/config.json` (mode 0640), and a hardened systemd
unit. Re-running with the same args is an idempotent restart; re-running
with a different `--token` rotates the token. The token is never echoed to
stdout and is not embedded in the unit file. Full flag list: `bash
install.sh --help`.

Or install the package directly:

```bash
npm install -g clawd-monitor-agent
```

Get the token from the dashboard: click "+ Add Agent" in the top nav
(generates the token and a paste-ready install command), or go to
Settings -> Agent Tokens.

## Usage

```bash
clawd-monitor-agent \
  --server https://your-clawd-monitor-domain \
  --token <agent-token-from-settings> \
  --name "My OpenClaw Host" \
  --gateway http://localhost:18789
```

See [docs/cli-reference.md](docs/cli-reference.md) for every flag and the
JSON config-file format.

## Documentation

- [docs/cli-reference.md](docs/cli-reference.md): full CLI flag reference and the JSON config-file format
- [docs/protocol.md](docs/protocol.md): the agent/server WebSocket protocol and lifecycle diagram
- [docs/systemd-service.md](docs/systemd-service.md): running the agent as a systemd service without the installer
- [docs/development.md](docs/development.md): testing notes (points to CONTRIBUTING.md for setup)
- [CHANGELOG.md](./CHANGELOG.md): per-release notes

## Development and contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, running locally, adding
a collector, and pull request conventions.

## License

MIT, see [LICENSE](./LICENSE). Pre-1.0: the WebSocket protocol and config
shape are not yet stable and may change between minor versions.

---

*Part of the [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor) ecosystem*
