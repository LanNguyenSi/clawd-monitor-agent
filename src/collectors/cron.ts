import type { CronJob } from '../types.js'
import { runOpenclaw, parseCliJson } from './cli.js'
import { cachedCall } from './cache.js'
import { withGatewayRpc } from './gateway-rpc.js'

export const CRON_CACHE_TTL_MS = 60_000

interface CliCronJob {
  id: string
  name?: string
  displayName?: string
  schedule: object
  enabled: boolean
  status?: string
  state?: {
    lastRunAtMs?: number
    nextRunAtMs?: number
    lastRunStatus?: string
    lastError?: string
  }
}

interface CronListResponse {
  jobs?: CliCronJob[]
}

function mapJobs(jobs: CliCronJob[]): CronJob[] {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name ?? job.displayName,
    schedule: job.schedule,
    enabled: job.enabled,
    status: job.status,
    state: job.state && {
      lastRunAtMs: job.state.lastRunAtMs,
      nextRunAtMs: job.state.nextRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
      lastError: job.state.lastError,
    },
  }))
}

/** Preferred path: `cron.list` over the Gateway WebSocket (read scope). */
export async function collectCronJobsViaGateway(gatewayUrl: string, token: string): Promise<CronJob[]> {
  return withGatewayRpc(gatewayUrl, token, async (call) => {
    const res = await call<CronListResponse>('cron.list', { includeDisabled: true })
    if (!Array.isArray(res.jobs)) throw new Error('unexpected cron.list payload')
    return mapJobs(res.jobs)
  })
}

/**
 * Collect cron jobs: Gateway RPC when a token is available (config
 * `gateway.token` or OPENCLAW_GATEWAY_TOKEN), otherwise the (cached) CLI.
 */
export async function collectCronJobs(
  gatewayUrl: string,
  gatewayToken?: string
): Promise<CronJob[]> {
  const token = gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN
  if (token) {
    try {
      return await collectCronJobsViaGateway(gatewayUrl, token)
    } catch {
      /* fall through to the CLI */
    }
  }
  try {
    const stdout = await cachedCall('cron', CRON_CACHE_TTL_MS, () =>
      runOpenclaw(['cron', 'list', '--all', '--json']),
    )
    const data = parseCliJson<CronListResponse>(stdout)
    if (!data.jobs || !Array.isArray(data.jobs)) return []
    return mapJobs(data.jobs)
  } catch {
    return []
  }
}
