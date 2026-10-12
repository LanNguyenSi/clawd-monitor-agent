import { execSync } from 'child_process'
import type { DockerContainer } from '../types.js'

/**
 * Reads the real restart count of the given containers with one batched
 * `docker inspect` call. Returns a map from short id to count. A container
 * whose count inspect did not print (it vanished, or inspect failed entirely)
 * has no entry, so callers leave its field undefined.
 */
function collectRestartCounts(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  // Only hex ids reach the shell command.
  const safeIds = ids.filter((id) => /^[0-9a-f]+$/i.test(id))
  if (safeIds.length === 0) return counts
  // docker inspect prints a literal backslash-t for "\\t" in --format (only
  // `docker ps` converts it), so the fields are separated by a plain space.
  const parse = (out: string): void => {
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [fullId, count] = line.trim().split(/\s+/)
      const n = Number(count)
      if (fullId && count !== undefined && Number.isInteger(n) && n >= 0) {
        counts.set(fullId.slice(0, 12), n)
      }
    }
  }
  try {
    parse(execSync(
      `docker inspect --format "{{.Id}} {{.RestartCount}}" ${safeIds.join(' ')}`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
    ))
  } catch (err) {
    // inspect exits non-zero when one id vanished but still prints the others
    const partial = (err as { stdout?: unknown }).stdout
    // (encoding 'utf-8' makes err.stdout a string or null)
    if (typeof partial === 'string') parse(partial)
    // otherwise report no restart count rather than a made-up one
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
