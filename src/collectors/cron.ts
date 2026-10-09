import type { CronJob } from '../types.js'
import { runOpenclaw, parseCliJson } from './cli.js'

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
    const stdout = await runOpenclaw(['cron', 'list', '--all', '--json'])
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
