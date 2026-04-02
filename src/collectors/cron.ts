import { execSync } from 'node:child_process'
import type { CronJob } from '../types.js'

interface CliCronJob {
  id: string
  name?: string
  schedule: object
  enabled: boolean
  state?: {
    lastRunAtMs?: number
    nextRunAtMs?: number
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
    const stdout = execSync('openclaw cron list --all --json', {
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const data: CronListResponse = JSON.parse(stdout)
    if (!data.jobs || !Array.isArray(data.jobs)) return []

    return data.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      enabled: job.enabled,
      state: job.state,
    }))
  } catch {
    return []
  }
}
