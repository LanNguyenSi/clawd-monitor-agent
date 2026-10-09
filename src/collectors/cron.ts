import type { CronJob } from '../types.js'
import { runOpenclaw, parseCliJson } from './cli.js'
import { cachedCall } from './cache.js'

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

export async function collectCronJobs(
  _gatewayUrl: string,
  _gatewayToken?: string
): Promise<CronJob[]> {
  try {
    const stdout = await cachedCall('cron', CRON_CACHE_TTL_MS, () =>
      runOpenclaw(['cron', 'list', '--all', '--json']),
    )
    const data = parseCliJson<CronListResponse>(stdout)
    if (!data.jobs || !Array.isArray(data.jobs)) return []

    return data.jobs.map((job) => ({
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
  } catch {
    return []
  }
}
