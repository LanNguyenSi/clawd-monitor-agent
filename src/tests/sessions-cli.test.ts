import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../collectors/cli.js', async (orig) => ({
  ...(await orig<typeof import('../collectors/cli.js')>()),
  runOpenclaw: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

import { runOpenclaw } from '../collectors/cli.js'
import { collectSessions } from '../collectors/sessions.js'
import { parseCliJson } from '../collectors/cli.js'

const cliPayload = {
  sessions: [
    { key: 'agent:main:old', kind: 'direct', model: 'a', updatedAt: 1000, status: 'done' },
    { key: 'agent:main:main', kind: 'direct', model: 'claude-sonnet-5-5', updatedAt: 2000, status: 'running', totalTokens: 31872 },
  ],
}

describe('collectSessions (openclaw sessions CLI)', () => {
  beforeEach(() => {
    vi.mocked(runOpenclaw).mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('maps CLI rows, newest first, without a gateway token', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify(cliPayload))
    const r = await collectSessions('http://gw', undefined)
    expect(runOpenclaw).toHaveBeenCalledWith(['sessions', '--all-agents', '--json', '--limit', '20'])
    expect(r.map((x) => x.sessionKey)).toEqual(['agent:main:main', 'agent:main:old'])
    expect(r[0]).toMatchObject({ kind: 'direct', model: 'claude-sonnet-5-5', status: 'running', totalTokens: 31872 })
    expect(r[0].lastMessageAt).toBe(new Date(2000).toISOString())
    expect(r[0].recentMessages).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tolerates log lines before the JSON document', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue('[plugins] loaded 3\n' + JSON.stringify(cliPayload))
    const r = await collectSessions('http://gw', undefined)
    expect(r).toHaveLength(2)
  })

  it('fills recentMessages from gateway history, keeping only user/assistant text', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [cliPayload.sessions[1]] }))
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
          { role: 'custom', content: [{ type: 'toolCall' }] },
          { role: 'toolResult', content: [{ type: 'text', text: 'x' }] },
          { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'hello' }], timestamp: 2 },
        ],
      }),
    } as unknown as Response)
    const r = await collectSessions('http://127.0.0.1:18789/', 'tok')
    const url = vi.mocked(fetch).mock.calls[0][0] as string
    expect(url).toBe('http://127.0.0.1:18789/sessions/agent%3Amain%3Amain/history?limit=40&includeTools=0')
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer tok' })
    expect(r[0].recentMessages?.map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'hello']])
  })

  it('survives a failing history endpoint', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [cliPayload.sessions[1]] }))
    vi.mocked(fetch).mockRejectedValue(new Error('boom'))
    const r = await collectSessions('http://gw', 'tok')
    expect(r[0].recentMessages).toEqual([])
  })

  it('falls back to legacy JSONL (→ []) when the CLI fails', async () => {
    vi.mocked(runOpenclaw).mockRejectedValue(new Error('ENOENT'))
    expect(await collectSessions('http://gw')).toEqual([])
  })
})

describe('parseCliJson', () => {
  it('throws when no JSON is present', () => {
    expect(() => parseCliJson('nope')).toThrow()
  })
})
