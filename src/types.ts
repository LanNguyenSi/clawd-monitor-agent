export interface AgentConfig {
  server: string
  token: string
  name: string
  agentId: string
  gateway: {
    url: string
    token?: string
  }
  clawd_dir: string
  collect: {
    sessions: boolean
    cron: boolean
    metrics: boolean
    memory: boolean
    docker: boolean
  }
  intervalMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface SessionMessage {
  role: string
  content: string
  timestamp?: string
}

export interface Session {
  sessionKey: string
  kind: string
  model?: string
  lastMessageAt?: string
  messageCount?: number
  recentMessages?: SessionMessage[]  // last N messages embedded in snapshot
}

export interface CronJob {
  id: string
  name?: string
  schedule: object
  enabled: boolean
  lastRunAt?: string
  nextRunAt?: string
}

export interface SystemMetrics {
  cpuPercent: number
  memUsedBytes: number
  memTotalBytes: number
  uptimeSeconds: number
}

export interface MemoryFiles {
  memory?: string
  current?: string
  today?: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'unknown'
  restarts: number
  uptime: string
}

export interface AgentSnapshot {
  agentId: string
  name: string
  timestamp: number
  version: string
  sessions: Session[]
  cronJobs: CronJob[]
  metrics: SystemMetrics
  memoryFiles: MemoryFiles
  containers: DockerContainer[]
}

// WebSocket message types
export type WsMessage =
  | { type: 'auth'; token: string; agentId: string; name: string; version: string; gatewayUrl?: string; gatewayToken?: string }
  | { type: 'auth_ok' }
  | { type: 'auth_error'; message: string }
  | { type: 'snapshot'; data: AgentSnapshot }
  | { type: 'ack' }
  | { type: 'ping' }
  | { type: 'pong' }
