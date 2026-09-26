# CLI reference

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | none | clawd-monitor URL (required) |
| `--token` | none | Agent token from Settings (required) |
| `--name` | OS hostname, or `unknown` | Display name in dashboard (uses `os.hostname()`; falls back to the literal string `unknown` if that call throws) |
| `--gateway` | `http://localhost:18789` | OpenClaw gateway URL |
| `--gateway-token` | none | OpenClaw gateway auth token |
| `--clawd-dir` | `~/.openclaw/workspace` | Path to OpenClaw workspace (memory files only, see note) |
| `--interval` | `5000` | Snapshot push interval (ms). Clamped to a minimum of 1000, whether set via `--interval` or `intervalMs` in a `--config` file. |
| `--config` | none | Path to JSON config file |
| `--no-memory` | off | Disable memory-file collection (collected by default) |
| `--no-docker` | off | Disable Docker collection (collected by default) |
| `--debug` | off | Enable debug logging |
| `--version` | none | Print version and exit |
| `--help`, `-h` | none | Show usage and exit |

`--clawd-dir` only governs where memory files (`MEMORY.md`, `CURRENT.md`, daily logs) are read from. Session discovery ignores it: sessions are always read from `~/.openclaw/agents/main/sessions/*.jsonl`.

## Config file

Any option above except `--config` itself can be set in a JSON file passed via `--config`:

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

A matching command-line flag overrides the same key from `--config`.

## Installer flags

`install.sh --help` prints the installer's own option list. It accepts `--server`, `--token`, `--name`, `--gateway`, `--gateway-token`, `--interval`, and `-h`/`--help`; it has no config-file or collector-toggle flags of its own (those are agent runtime options, set later via the CLI or the config file it writes at `/etc/clawd-monitor-agent/config.json`).
