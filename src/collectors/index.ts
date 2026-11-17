import { collectSessions } from './sessions.js'
import { collectCronJobs } from './cron.js'
import { collectMetrics } from './metrics.js'
import { collectMemory } from './memory.js'
import { collectDocker } from './docker.js'
import type { AgentConfig, AgentSnapshot } from '../types.js'
import { VERSION } from '../version.js'

export async function collectSnapshot(config: AgentConfig): Promise<AgentSnapshot> {
  const gatewayToken = config.gateway.collectorToken ?? config.gateway.token
  const [sessions, cronJobs] = await Promise.all([
    config.collect.sessions
      ? collectSessions(config.gateway.url, gatewayToken, config.clawd_dir)
      : Promise.resolve([]),
    config.collect.cron
      ? collectCronJobs(config.gateway.url, gatewayToken)
      : Promise.resolve([]),
  ])

  const metrics = config.collect.metrics ? collectMetrics() : {
    cpuPercent: 0, memUsedBytes: 0, memTotalBytes: 0, uptimeSeconds: 0,
  }

  const memoryFiles = config.collect.memory
    ? collectMemory(config.clawd_dir)
    : {}

  const containers = config.collect.docker ? collectDocker() : []

  return {
    agentId: config.agentId,
    name: config.name,
    timestamp: Date.now(),
    version: VERSION,
    sessions,
    cronJobs,
    metrics,
    memoryFiles,
    containers,
  }
}
