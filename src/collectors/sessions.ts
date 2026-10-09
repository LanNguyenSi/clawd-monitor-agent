import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Session, SessionMessage } from '../types.js'
import { runOpenclaw, parseCliJson } from './cli.js'
import { cachedCall } from './cache.js'
import { withGatewayRpc } from './gateway-rpc.js'

export const SESSIONS_CACHE_TTL_MS = 30_000

const MAX_RECENT_MESSAGES = 5

/**
 * Legacy collector (OpenClaw < 2026.9): reads local JSONL transcripts from
 * ~/.openclaw/agents/main/sessions/*.jsonl. Newer releases keep sessions in
 * SQLite and leave this directory empty, so this is only a fallback.
 */
export async function collectLegacyJsonlSessions(
  _clawdDir?: string
): Promise<Session[]> {
  try {
    const base = join(homedir(), '.openclaw')
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
                    content: content.slice(0, 200), // truncate per message
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

interface CliSession {
  key: string
  agentId?: string
  kind?: string
  model?: string
  updatedAt?: number
  status?: string
  totalTokens?: number
}

interface CliSessionsResponse {
  sessions?: CliSession[]
}

interface HistoryItem {
  role?: string
  content?: unknown
  timestamp?: number | string
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => (b as Record<string, unknown>)?.type === 'text')
    .map((b) => String((b as Record<string, unknown>).text ?? ''))
    .join('\n')
    .trim()
}

/**
 * Fetch the last few user/assistant messages from the local Gateway HTTP
 * history endpoint (GET /sessions/<key>/history). Best effort: returns []
 * when no token is configured or the Gateway is unreachable.
 */
export async function fetchRecentMessages(
  gatewayUrl: string,
  gatewayToken: string | undefined,
  sessionKey: string,
): Promise<SessionMessage[]> {
  if (!gatewayToken) return []
  try {
    const url = `${gatewayUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionKey)}/history?limit=100&includeTools=0`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { items?: HistoryItem[]; messages?: HistoryItem[] }
    const items = data.items ?? data.messages ?? []
    const out: SessionMessage[] = []
    for (const it of items) {
      if (it.role !== 'user' && it.role !== 'assistant') continue
      const content = textOf(it.content)
      if (!content) continue
      out.push({
        role: it.role,
        content: content.slice(0, 200),
        timestamp: typeof it.timestamp === 'number' ? new Date(it.timestamp).toISOString()
          : typeof it.timestamp === 'string' ? it.timestamp : undefined,
      })
    }
    return out.slice(-MAX_RECENT_MESSAGES)
  } catch {
    return []
  }
}

interface PreviewResponse {
  previews?: Array<{ key: string; status?: string; items?: Array<{ role?: string; text?: string }> }>
}

function toSession(row: CliSession, recentMessages: SessionMessage[]): Session {
  return {
    sessionKey: row.key,
    kind: row.kind ?? 'main',
    model: row.model,
    lastMessageAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    status: row.status,
    totalTokens: row.totalTokens,
    recentMessages,
  }
}

/**
 * Preferred path (OpenClaw 2026.9+): ask the local Gateway over WebSocket.
 * `sessions.list` gives the rows, one bulk `sessions.preview` gives the last
 * messages. Unlike `chat.history`, preview never restores archived (cold)
 * transcripts, so polling is side-effect free. ~tens of ms, no child process.
 */
export async function collectSessionsViaGateway(
  gatewayUrl: string,
  token: string,
): Promise<Session[]> {
  return withGatewayRpc(gatewayUrl, token, async (call) => {
    const list = await call<CliSessionsResponse>('sessions.list', { limit: 20 })
    if (!Array.isArray(list.sessions)) throw new Error('unexpected sessions.list payload')

    const rows = [...list.sessions]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 20)

    const byKey = new Map<string, SessionMessage[]>()
    if (rows.length > 0) {
      try {
        const prev = await call<PreviewResponse>('sessions.preview', {
          keys: rows.map((r) => r.key),
          limit: MAX_RECENT_MESSAGES,
          maxChars: 200,
        })
        for (const p of prev.previews ?? []) {
          const msgs: SessionMessage[] = []
          for (const it of p.items ?? []) {
            if ((it.role === 'user' || it.role === 'assistant') && it.text) {
              msgs.push({ role: it.role, content: it.text.slice(0, 200) })
            }
          }
          byKey.set(p.key, msgs.slice(-MAX_RECENT_MESSAGES))
        }
      } catch {
        /* previews are best effort; the session rows are still useful */
      }
    }
    return rows.map((row) => toSession(row, byKey.get(row.key) ?? []))
  })
}

/**
 * Collect sessions. Order of preference:
 *  1. Gateway WebSocket RPC (needs a Gateway token: config `gateway.token` or
 *     the OPENCLAW_GATEWAY_TOKEN env var, which stays on the host),
 *  2. `openclaw sessions --all-agents --json` (+ HTTP history), cached,
 *  3. legacy JSONL transcripts (OpenClaw < 2026.9).
 */
export async function collectSessions(
  gatewayUrl: string,
  gatewayToken?: string,
  clawdDir?: string
): Promise<Session[]> {
  // config.gateway.token is forwarded to the dashboard server; the env var is not.
  const historyToken = gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN
  if (historyToken) {
    try {
      return await collectSessionsViaGateway(gatewayUrl, historyToken)
    } catch {
      /* fall through to the CLI */
    }
  }
  try {
    const stdout = await cachedCall('sessions', SESSIONS_CACHE_TTL_MS, () =>
      runOpenclaw(['sessions', '--all-agents', '--json', '--limit', '20']),
    )
    const data = parseCliJson<CliSessionsResponse>(stdout)
    if (!Array.isArray(data.sessions)) throw new Error('unexpected sessions payload')

    const rows = [...data.sessions]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 20)

    return await Promise.all(
      rows.map(async (row): Promise<Session> =>
        toSession(row, await fetchRecentMessages(gatewayUrl, historyToken, row.key)),
      ),
    )
  } catch {
    return collectLegacyJsonlSessions(clawdDir)
  }
}
