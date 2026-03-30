import WebSocket from 'ws'
import { collectSnapshot } from './collectors/index.js'
import type { AgentConfig, WsMessage } from './types.js'

const VERSION = '1.0.0'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export class Agent {
  private config: AgentConfig
  private ws: WebSocket | null = null
  private authenticated = false
  private reconnectDelay = 1000
  private pushTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(config: AgentConfig) {
    this.config = config
  }

  private log(level: LogLevel, ...args: unknown[]) {
    if (LOG_LEVELS[level] >= LOG_LEVELS[this.config.logLevel]) {
      const prefix = `[clawd-agent][${level.toUpperCase()}]`
      console.log(prefix, ...args)
    }
  }

  start() {
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    this.ws?.close()
  }

  private clearTimers() {
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
  }

  private connect() {
    if (this.stopped) return

    const wsUrl = this.config.server.replace(/^http/, 'ws') + '/api/agents/ws'
    this.log('info', `Connecting to ${wsUrl}…`)

    const ws = new WebSocket(wsUrl, {
      headers: { 'User-Agent': `clawd-monitor-agent/${VERSION}` },
    })
    this.ws = ws
    this.authenticated = false

    ws.on('open', () => {
      this.log('info', 'Connected — authenticating…')
      this.reconnectDelay = 1000 // reset backoff on successful connect

      const authMsg: WsMessage = {
        type: 'auth',
        token: this.config.token,
        agentId: this.config.agentId,
        name: this.config.name,
        version: VERSION,
        gatewayUrl: this.config.gateway.url,
        gatewayToken: this.config.gateway.token,
      }
      ws.send(JSON.stringify(authMsg))
    })

    ws.on('message', (data) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(data.toString()) as WsMessage
      } catch {
        return
      }

      if (msg.type === 'auth_ok') {
        this.log('info', `Authenticated as "${this.config.name}" (${this.config.agentId})`)
        this.authenticated = true
        this.startPushLoop()
        this.startPingLoop()
      } else if (msg.type === 'auth_error') {
        this.log('error', `Authentication failed: ${msg.message}`)
        this.stopped = true
        ws.close()
      } else if (msg.type === 'pong') {
        this.log('debug', 'Pong received')
      } else if (msg.type === 'ack') {
        this.log('debug', 'Snapshot acknowledged')
      }
    })

    ws.on('close', (code) => {
      this.log('info', `Disconnected (code ${code})`)
      this.clearTimers()
      this.authenticated = false
      if (!this.stopped) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.log('warn', `WebSocket error: ${err.message}`)
    })
  }

  private scheduleReconnect() {
    const delay = this.reconnectDelay
    this.log('info', `Reconnecting in ${delay}ms…`)
    setTimeout(() => this.connect(), delay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
  }

  private startPushLoop() {
    // Push immediately, then on interval
    void this.pushSnapshot()
    this.pushTimer = setInterval(() => void this.pushSnapshot(), this.config.intervalMs)
  }

  private startPingLoop() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30_000)
  }

  private async pushSnapshot() {
    if (!this.authenticated || this.ws?.readyState !== WebSocket.OPEN) return

    try {
      const snapshot = await collectSnapshot(this.config)
      const msg: WsMessage = { type: 'snapshot', data: snapshot }
      this.ws.send(JSON.stringify(msg))
      this.log('debug', `Snapshot pushed (${snapshot.sessions.length} sessions, ${snapshot.cronJobs.length} crons, ${snapshot.containers.length} containers)`)
    } catch (err) {
      this.log('warn', `Failed to collect/push snapshot: ${err}`)
    }
  }
}
