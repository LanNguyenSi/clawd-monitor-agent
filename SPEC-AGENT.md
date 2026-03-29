# Spec: clawd-monitor-agent (Client)

*Authored by Ice 🧊 — For Lava to implement*

---

## Overview

`clawd-monitor-agent` is a lightweight Node.js process that runs on each OpenClaw host. It:
1. Connects outbound via WebSocket to clawd-monitor
2. Authenticates with an agent token
3. Pushes collected snapshots at a configurable interval
4. Never requires inbound ports — one-way outbound connection

---

## Stack

- Node.js 18+, TypeScript
- `ws` package for WebSocket
- No framework dependencies
- Single binary via `pkg` or direct `node` execution
- Ships as npm package: `clawd-monitor-agent`

---

## Directory Structure

```
clawd-monitor-agent/
├── src/
│   ├── cli.ts              → Entry point (parse args, load config, start)
│   ├── agent.ts            → Main Agent class (connect, reconnect, push loop)
│   ├── config.ts           → Config loading + validation
│   ├── collectors/
│   │   ├── sessions.ts     → Fetch active sessions from OpenClaw Gateway
│   │   ├── cron.ts         → Fetch cron jobs from OpenClaw Gateway
│   │   ├── metrics.ts      → Read /proc/stat + /proc/meminfo (CPU/RAM)
│   │   ├── memory.ts       → Read MEMORY.md, CURRENT.md, daily log files
│   │   ├── docker.ts       → Run docker ps -a, parse output
│   │   └── index.ts        → Run all collectors, return AgentSnapshot
│   └── types.ts            → Shared types
├── package.json
├── tsconfig.json
└── .github/workflows/ci.yml
```

---

## Types

```typescript
// AgentSnapshot — what gets pushed every intervalMs
interface AgentSnapshot {
  agentId: string           // stable UUID, generated on first run, persisted
  name: string              // human-readable name from config
  timestamp: number         // Unix ms
  version: string           // agent version

  sessions: Session[]
  cronJobs: CronJob[]
  metrics: SystemMetrics
  memoryFiles: MemoryFiles
  containers: DockerContainer[]
}

interface Session {
  key: string
  kind: string
  model?: string
  lastMessageAt?: string
  messageCount?: number
}

interface CronJob {
  id: string
  name?: string
  schedule: object
  enabled: boolean
  lastRunAt?: string
  nextRunAt?: string
}

interface SystemMetrics {
  cpuPercent: number        // 0-100
  memUsedBytes: number
  memTotalBytes: number
  uptimeSeconds: number
}

interface MemoryFiles {
  memory?: string           // MEMORY.md content (truncated to 10KB)
  current?: string          // CURRENT.md content
  today?: string            // today's daily log
}

interface DockerContainer {
  id: string
  name: string
  image: string
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'unknown'
  restarts: number
  uptime: string
}
```

---

## WebSocket Protocol

### Connection

```
wss://clawd-monitor.opentriologue.ai/api/agents/ws
```

### Handshake (on connect)

Agent sends:
```json
{
  "type": "auth",
  "token": "<agent-token>",
  "agentId": "<stable-uuid>",
  "name": "Ice (local)",
  "version": "1.0.0"
}
```

Server responds:
```json
{ "type": "auth_ok" }
// or
{ "type": "auth_error", "message": "Invalid token" }
```

### Data Push (every intervalMs after auth_ok)

Agent sends:
```json
{
  "type": "snapshot",
  "data": { ...AgentSnapshot }
}
```

Server responds:
```json
{ "type": "ack" }
```

### Heartbeat

Agent sends every 30s:
```json
{ "type": "ping" }
```

Server responds:
```json
{ "type": "pong" }
```

### Reconnect Logic

- On disconnect: exponential backoff (1s, 2s, 4s, 8s, max 60s)
- On auth_error: log error, stop reconnecting
- Connection state logged to stdout

---

## Collectors Detail

### sessions.ts
- `GET <gatewayUrl>/sessions` with Bearer token
- Returns: `{ sessions: Session[] }`
- On error: return `[]`

### cron.ts
- `GET <gatewayUrl>/cron/jobs` with Bearer token
- Returns: `{ jobs: CronJob[] }`
- On error: return `[]`

### metrics.ts
- Read `/proc/stat` for CPU diff calculation
- Read `/proc/meminfo` for RAM
- Falls back to zeros on non-Linux systems
- Includes OS uptime from `/proc/uptime`

### memory.ts
- Reads files from `config.clawd_dir` (default: `~/.openclaw/workspace`)
- Files: `MEMORY.md`, `CURRENT.md`, `memory/YYYY-MM-DD.md` (today)
- Truncates each file to 10KB to limit payload size
- On file-not-found: returns `undefined` for that field
- **Never reads .env or any file outside clawd_dir**

### docker.ts
- Runs `docker ps -a --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.RunningFor}}"`
- On error (docker not available): returns `[]`

---

## Config Schema

```typescript
interface AgentConfig {
  server: string            // clawd-monitor URL (required)
  token: string             // agent token (required)
  name: string              // display name (default: hostname)
  agentId?: string          // auto-generated UUID if not set, persisted to ~/.clawd-agent-id

  gateway: {
    url: string             // OpenClaw Gateway URL (default: http://localhost:9500)
    token?: string          // Gateway API token
  }

  clawd_dir?: string        // Path to openclaw workspace (default: ~/.openclaw/workspace)

  collect: {
    sessions: boolean       // default: true
    cron: boolean           // default: true
    metrics: boolean        // default: true
    memory: boolean         // default: true (reads MEMORY.md etc)
    docker: boolean         // default: true
  }

  intervalMs: number        // push interval (default: 5000, min: 1000)
  logLevel: 'debug' | 'info' | 'warn' | 'error'  // default: 'info'
}
```

---

## CLI Interface

```bash
clawd-monitor-agent [options]

Options:
  --server <url>          clawd-monitor server URL (required)
  --token <token>         Agent authentication token (required)
  --name <name>           Agent display name (default: hostname)
  --gateway <url>         OpenClaw Gateway URL (default: http://localhost:9500)
  --gateway-token <token> OpenClaw Gateway API token
  --clawd-dir <path>      Path to openclaw workspace
  --interval <ms>         Push interval in milliseconds (default: 5000)
  --config <path>         Path to JSON config file
  --no-memory             Disable memory file collection
  --no-docker             Disable docker collection
  --debug                 Enable debug logging
  --version               Show version
  --help                  Show help
```

---

## Acceptance Criteria

- [ ] `npm install -g clawd-monitor-agent` works
- [ ] `clawd-monitor-agent --server ... --token ... --name ...` starts without error
- [ ] Agent connects to clawd-monitor WebSocket endpoint
- [ ] Authentication handshake works (auth → auth_ok)
- [ ] Snapshots pushed every intervalMs
- [ ] Reconnects automatically on disconnect (exponential backoff)
- [ ] All collectors return empty/zero on error (never crash)
- [ ] Memory collector never reads outside clawd_dir
- [ ] TypeScript strict mode, zero errors
- [ ] Unit tests for collectors (mocked filesystem/HTTP)
- [ ] CI: Node 20 + 22

---

## Security Constraints

- Memory collector is read-only, clawd_dir-scoped
- No credential files (.env, .npmrc, etc.) ever collected
- Agent token stored in config file with appropriate permissions (chmod 600)
- Agent ID is a random UUID, not hostname or IP
