import type { CronJob } from '../types.js'

export async function collectCronJobs(
  gatewayUrl: string,
  gatewayToken?: string
): Promise<CronJob[]> {
  try {
    const headers: Record<string, string> = {}
    if (gatewayToken) headers['Authorization'] = `Bearer ${gatewayToken}`

    const res = await fetch(`${gatewayUrl}/cron/jobs`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []

    const data = await res.json() as { jobs?: CronJob[] }
    return data.jobs ?? []
  } catch {
    return []
  }
}
