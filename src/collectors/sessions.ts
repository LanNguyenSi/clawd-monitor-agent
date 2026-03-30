import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Session, SessionMessage } from '../types.js'

const MAX_RECENT_MESSAGES = 20

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
        const allMessages: SessionMessage[] = []

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            // OpenClaw JSONL format: { type, id, timestamp, message?: { role, content } }
            if (entry.type === 'session') {
              sessionKey = typeof entry.id === 'string' ? `agent:main:${entry.id}` : undefined
            } else if (entry.type === 'message') {
              const msg = entry.message as Record<string, unknown> | undefined
              const role = typeof msg?.role === 'string' ? msg.role : undefined
              if (role === 'user' || role === 'assistant') {
                messageCount++
                const rawContent = msg?.content
                let content = ''
                if (typeof rawContent === 'string') {
                  content = rawContent
                } else if (Array.isArray(rawContent)) {
                  content = rawContent
                    .filter((b: unknown) => (b as Record<string, unknown>)?.type === 'text')
                    .map((b: unknown) => (b as Record<string, unknown>)?.text ?? '')
                    .join('\n')
                    .trim()
                }
                if (content) {
                  allMessages.push({
                    role,
                    content: content.slice(0, 500), // truncate per message
                    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
                  })
                }
              }
              if (typeof entry.timestamp === 'string') lastMessageAt = entry.timestamp
            } else if (entry.type === 'model_change') {
              const modelId = (entry as Record<string, unknown>).modelId
              if (typeof modelId === 'string') model = modelId.split('/').pop()
            }
          } catch { /* skip malformed lines */ }
        }

        if (messageCount === 0) continue // skip empty sessions

        sessions.push({
          sessionKey: sessionKey ?? `agent:main:${sessionId}`,
          kind: 'main',
          model,
          lastMessageAt: lastMessageAt ?? stats.mtime.toISOString(),
          messageCount,
          recentMessages: allMessages.slice(-MAX_RECENT_MESSAGES),
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
