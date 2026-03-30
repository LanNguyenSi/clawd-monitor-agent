import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Session } from '../types.js'

/**
 * Collect sessions by reading local JSONL files.
 * The OpenClaw gateway HTTP /sessions endpoint returns the web UI (SPA catch-all),
 * so we read directly from ~/.openclaw/agents/main/sessions/*.jsonl instead.
 */
export async function collectSessions(
  _gatewayUrl: string,
  _gatewayToken?: string,
  clawdDir?: string
): Promise<Session[]> {
  try {
    const base = clawdDir ? join(clawdDir, '..') : join(homedir(), '.openclaw')
    const sessionsDir = join(base, 'agents', 'main', 'sessions')

    const files = await readdir(sessionsDir)
    const jsonlFiles = files.filter(
      (f) => f.endsWith('.jsonl') && !f.includes('.lock') && !f.includes('.deleted') && !f.includes('.reset')
    )

    const sessions: Session[] = []

    for (const file of jsonlFiles) {
      const filePath = join(sessionsDir, file)
      try {
        const stats = await stat(filePath)
        const sessionId = file.replace('.jsonl', '')

        const content = await readFile(filePath, 'utf-8')
        const lines = content.trim().split('\n').filter(Boolean)

        let model: string | undefined
        let lastMessageAt: string | undefined
        let messageCount = 0
        let sessionKey: string | undefined

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            // OpenClaw JSONL format: { type, id, timestamp, message?: { role, content } }
            if (entry.type === 'session') {
              sessionKey = typeof entry.id === 'string' ? `agent:main:${entry.id}` : undefined
            } else if (entry.type === 'message') {
              const msg = entry.message as Record<string, unknown> | undefined
              if (msg?.role === 'user' || msg?.role === 'assistant') messageCount++
              if (typeof entry.timestamp === 'string') lastMessageAt = entry.timestamp
            } else if (entry.type === 'model_change') {
              const modelId = (entry as Record<string, unknown>).modelId
              if (typeof modelId === 'string') model = modelId.split('/').pop()
            }
          } catch { /* skip malformed lines */ }
        }

        if (messageCount === 0) continue // skip empty sessions

        sessions.push({
          key: sessionKey ?? `agent:main:${sessionId}`,
          kind: 'main',
          model,
          lastMessageAt: lastMessageAt ?? stats.mtime.toISOString(),
          messageCount,
        })
      } catch { /* skip unreadable files */ }
    }

    return sessions
      .sort((a, b) => new Date(b.lastMessageAt ?? 0).getTime() - new Date(a.lastMessageAt ?? 0).getTime())
      .slice(0, 20)
  } catch {
    return []
  }
}
