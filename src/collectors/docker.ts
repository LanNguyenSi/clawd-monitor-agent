import { execSync } from 'child_process'
import type { DockerContainer } from '../types.js'

export function collectDocker(): DockerContainer[] {
  try {
    const out = execSync(
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.RunningFor}}"',
      { encoding: 'utf-8', timeout: 5000 }
    )
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('\t')
      const statusStr = parts[3] ?? ''
      const restartMatch = statusStr.match(/\((\d+)\)/)
      const rawState = (parts[4] ?? 'unknown').trim()
      const state: DockerContainer['state'] = ['running', 'exited', 'paused', 'restarting'].includes(rawState)
        ? rawState as DockerContainer['state']
        : 'unknown'

      return {
        id: (parts[0] ?? '').slice(0, 12),
        name: parts[1] ?? '',
        image: (parts[2] ?? '').split(':')[0] ?? '',
        state,
        restarts: restartMatch ? parseInt(restartMatch[1]) : 0,
        uptime: parts[5] ?? '',
      }
    })
  } catch {
    return []
  }
}
