import { execSync } from 'child_process'
import type { DockerContainer } from '../types.js'

/**
 * Reads the real restart count of the given containers with one batched
 * `docker inspect` call. Returns a map from short id to count; an empty map
 * when inspect fails, so callers leave the field undefined.
 */
function collectRestartCounts(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  // Only hex ids reach the shell command.
  const safeIds = ids.filter((id) => /^[0-9a-f]+$/i.test(id))
  if (safeIds.length === 0) return counts
  try {
    const out = execSync(
      `docker inspect --format "{{.Id}}\\t{{.RestartCount}}" ${safeIds.join(' ')}`,
      { encoding: 'utf-8', timeout: 5000 }
    )
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [fullId, count] = line.split('\t')
      const n = Number(count)
      if (fullId && count !== undefined && count.trim() !== '' && Number.isInteger(n) && n >= 0) {
        counts.set(fullId.slice(0, 12), n)
      }
    }
  } catch {
    // inspect failed: report no restart count rather than a made-up one
  }
  return counts
}

export function collectDocker(): DockerContainer[] {
  try {
    const out = execSync(
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.RunningFor}}"',
      { encoding: 'utf-8', timeout: 5000 }
    )
    const containers: DockerContainer[] = out.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('\t')
      const rawState = (parts[4] ?? 'unknown').trim()
      const state: DockerContainer['state'] = ['running', 'exited', 'paused', 'restarting'].includes(rawState)
        ? rawState as DockerContainer['state']
        : 'unknown'

      return {
        id: (parts[0] ?? '').slice(0, 12),
        name: parts[1] ?? '',
        image: (parts[2] ?? '').split(':')[0] ?? '',
        state,
        uptime: parts[5] ?? '',
      }
    })
    const counts = collectRestartCounts(containers.map((c) => c.id))
    for (const c of containers) {
      const n = counts.get(c.id)
      if (n !== undefined) c.restarts = n
    }
    return containers
  } catch {
    return []
  }
}
