import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CronJob } from '../types.js'

const execFileAsync = promisify(execFile)

/**
 * Collect cron jobs via `openclaw cron list --json`.
 * The OpenClaw gateway does not expose a REST endpoint for cron —
 * the HTTP gateway returns HTML (SPA catch-all). The CLI is reliable.
 */
export async function collectCronJobs(
  _gatewayUrl: string,
  _gatewayToken?: string
): Promise<CronJob[]> {
  try {
    const { stdout } = await execFileAsync('openclaw', ['cron', 'list', '--json'], {
      timeout: 8000,
    })

    const data = JSON.parse(stdout) as { jobs?: Array<Record<string, unknown>> }
    const rawJobs = data.jobs ?? []

    return rawJobs.map((job): CronJob => ({
      id: String(job.id ?? ''),
      name: typeof job.name === 'string' ? job.name : undefined,
      schedule: (job.schedule as object) ?? {},
      enabled: Boolean(job.enabled),
      // Map from state.nextRunAtMs / state.lastRunAtMs (ms epoch)
      nextRunAt: job.state && typeof (job.state as Record<string, unknown>).nextRunAtMs === 'number'
        ? new Date((job.state as Record<string, unknown>).nextRunAtMs as number).toISOString()
        : undefined,
      lastRunAt: job.state && typeof (job.state as Record<string, unknown>).lastRunAtMs === 'number'
        ? new Date((job.state as Record<string, unknown>).lastRunAtMs as number).toISOString()
        : undefined,
    }))
  } catch {
    return []
  }
}
