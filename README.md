# clawd-monitor-agent

Push-based monitoring agent for [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor).

Runs on each OpenClaw host, connects outbound to a central clawd-monitor dashboard, and pushes live snapshots every 5 seconds — no inbound ports required on the agent host.

## What it collects

| Data | Description |
|------|-------------|
| Sessions | Active OpenClaw sessions (read from local JSONL files) |
| Cron Jobs | Scheduled jobs with next/last run times |
| CPU + RAM | System metrics via `/proc` |
| Memory files | MEMORY.md, CURRENT.md, today's daily log |
| Docker containers | Running containers, state, uptime, restarts |
| Session messages | Last 5 messages per session (embedded in snapshot) |

## Install

```bash
npm install -g clawd-monitor-agent
```

## Usage

```bash
clawd-monitor-agent \
  --server https://your-clawd-monitor-domain \
  --token <agent-token-from-settings> \
  --name "My OpenClaw Host" \
  --gateway http://localhost:18789
```

Get the token from the clawd-monitor Settings page (Settings → Agent Tokens → Generate).

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | — | clawd-monitor URL (required) |
| `--token` | — | Agent token from Settings (required) |
| `--name` | hostname | Display name in dashboard |
| `--gateway` | `http://localhost:18789` | OpenClaw gateway URL |
| `--gateway-token` | — | OpenClaw gateway auth token |
| `--clawd-dir` | `~/.openclaw/workspace` | Path to OpenClaw workspace |
| `--interval` | `5000` | Snapshot push interval (ms) |
| `--config` | — | Path to JSON config file |

## Config file

```json
{
  "server": "https://your-clawd-monitor-domain",
  "token": "<agent-token>",
  "name": "My OpenClaw Host",
  "gateway": {
    "url": "http://localhost:18789"
  },
  "collect": {
    "sessions": true,
    "cron": true,
    "metrics": true,
    "memory": true,
    "docker": true
  },
  "intervalMs": 5000
}
```

## As a systemd service

```ini
[Unit]
Description=clawd-monitor agent
After=network.target

[Service]
ExecStart=/usr/bin/clawd-monitor-agent \
  --server https://your-clawd-monitor-domain \
  --token <agent-token> \
  --name "My OpenClaw Host" \
  --gateway http://localhost:18789
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

*Part of the [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor) ecosystem*
