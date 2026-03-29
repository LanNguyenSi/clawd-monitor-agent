# clawd-monitor-agent

Push-based monitoring agent for [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor).

Runs on each OpenClaw host, connects outbound to the central clawd-monitor dashboard, and pushes live data — no inbound ports required.

**Status:** 🚧 In development

## Architecture

```
OpenClaw Host (Ice/Lava VPS)          Stone VPS
┌─────────────────────────────┐       ┌──────────────────────────┐
│  clawd-monitor-agent        │       │  clawd-monitor           │
│  ┌─────────────────────┐    │       │  ┌────────────────────┐  │
│  │ Collectors          │    │       │  │ Agent Registry     │  │
│  │ - sessions          │    │       │  │ - connected agents │  │
│  │ - cron jobs         │────┼──────▶│  │ - latest snapshots │  │
│  │ - metrics (CPU/RAM) │    │ WSS   │  │ - event stream     │  │
│  │ - memory files      │    │       │  └────────────────────┘  │
│  │ - docker containers │    │       │          │               │
│  └─────────────────────┘    │       │  Dashboard (widgets)     │
│                             │       │  show multi-agent data   │
└─────────────────────────────┘       └──────────────────────────┘
```

## Install

```bash
npm install -g clawd-monitor-agent
```

## Usage

```bash
# Start agent
clawd-monitor-agent \
  --server https://clawd-monitor.opentriologue.ai \
  --token <agent-token> \
  --name "Ice (local)" \
  --gateway http://localhost:9500 \
  --gateway-token <openclaw-token>

# Or via config file
clawd-monitor-agent --config ~/.clawd-monitor-agent.json
```

## Config file

```json
{
  "server": "https://clawd-monitor.opentriologue.ai",
  "token": "<agent-token>",
  "name": "Ice (local)",
  "gateway": {
    "url": "http://localhost:9500",
    "token": "<openclaw-gateway-token>"
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
ExecStart=/usr/bin/clawd-monitor-agent --config /etc/clawd-monitor-agent.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

*Part of the clawd-monitor ecosystem*
