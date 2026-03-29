import type { Session } from '../types.js'

export async function collectSessions(
  gatewayUrl: string,
  gatewayToken?: string
): Promise<Session[]> {
  try {
    const headers: Record<string, string> = {}
    if (gatewayToken) headers['Authorization'] = `Bearer ${gatewayToken}`

    const res = await fetch(`${gatewayUrl}/sessions`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return []

    const data = await res.json() as { sessions?: Session[] }
    return data.sessions ?? []
  } catch {
    return []
  }
}
