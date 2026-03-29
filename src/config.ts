import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type { AgentConfig } from './types.js'

const AGENT_ID_FILE = join(homedir(), '.clawd-agent-id')

function getOrCreateAgentId(): string {
  if (existsSync(AGENT_ID_FILE)) {
    return readFileSync(AGENT_ID_FILE, 'utf-8').trim()
  }
  const id = randomUUID()
  writeFileSync(AGENT_ID_FILE, id, { mode: 0o600 })
  return id
}

interface CliArgs {
  server?: string
  token?: string
  name?: string
  gateway?: string
  'gateway-token'?: string
  'clawd-dir'?: string
  interval?: string
  config?: string
  memory?: boolean
  docker?: boolean
  debug?: boolean
}

export function loadConfig(args: CliArgs): AgentConfig {
  let fileConfig: Partial<AgentConfig> = {}

  if (args.config) {
    try {
      fileConfig = JSON.parse(readFileSync(args.config, 'utf-8')) as Partial<AgentConfig>
    } catch (err) {
      console.error(`Failed to read config file: ${args.config}`)
      process.exit(1)
    }
  }

  const server = args.server ?? fileConfig.server
  const token = args.token ?? fileConfig.token

  if (!server) {
    console.error('Error: --server <url> is required')
    process.exit(1)
  }
  if (!token) {
    console.error('Error: --token <token> is required')
    process.exit(1)
  }

  const hostname = (() => {
    try { return readFileSync('/etc/hostname', 'utf-8').trim() } catch { return 'unknown' }
  })()

  const intervalMs = args.interval
    ? Math.max(1000, parseInt(args.interval))
    : fileConfig.intervalMs ?? 5000

  return {
    server,
    token,
    name: args.name ?? fileConfig.name ?? hostname,
    agentId: fileConfig.agentId ?? getOrCreateAgentId(),
    gateway: {
      url: args.gateway ?? fileConfig.gateway?.url ?? 'http://localhost:18789',
      token: args['gateway-token'] ?? fileConfig.gateway?.token,
    },
    clawd_dir: args['clawd-dir'] ?? fileConfig.clawd_dir ?? join(homedir(), '.openclaw', 'workspace'),
    collect: {
      sessions: fileConfig.collect?.sessions ?? true,
      cron:     fileConfig.collect?.cron     ?? true,
      metrics:  fileConfig.collect?.metrics  ?? true,
      memory:   args.memory !== false && (fileConfig.collect?.memory ?? true),
      docker:   args.docker !== false && (fileConfig.collect?.docker  ?? true),
    },
    intervalMs,
    logLevel: args.debug ? 'debug' : (fileConfig.logLevel ?? 'info'),
  }
}
