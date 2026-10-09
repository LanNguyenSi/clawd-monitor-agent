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
    expect(url).toBe('http://127.0.0.1:18789/sessions/agent%3Amain%3Amain/history?limit=100&includeTools=0')
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

describe('collectSessions history token source', () => {
  beforeEach(() => {
    vi.mocked(runOpenclaw).mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('uses OPENCLAW_GATEWAY_TOKEN when no gateway token is passed', async () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'env-tok')
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [{ key: 'k' }] }))
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) } as unknown as Response)
    await collectSessions('http://gw')
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer env-tok' })
  })

  it('prefers an explicit token over the environment', async () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'env-tok')
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [{ key: 'k' }] }))
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) } as unknown as Response)
    await collectSessions('http://gw', 'cfg-tok')
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer cfg-tok' })
  })
})

describe('collectSessions edge cases', () => {
  beforeEach(() => {
    vi.mocked(runOpenclaw).mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('defaults kind to main and omits lastMessageAt when updatedAt is missing', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [{ key: 'k' }] }))
    const r = await collectSessions('http://gw')
    expect(r[0]).toMatchObject({ sessionKey: 'k', kind: 'main' })
    expect(r[0].lastMessageAt).toBeUndefined()
  })

  it('falls back to legacy when the payload has no sessions array', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ nope: true }))
    expect(await collectSessions('http://gw')).toEqual([])
  })

  it('handles string content, string timestamps, the legacy "messages" key and caps at 5', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [{ key: 'k', updatedAt: 1 }] }))
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: 'user', content: 'm' + i, timestamp: '2026-01-01T00:00:0' + i + 'Z',
    }))
    messages.push({ role: 'assistant', content: '   ', timestamp: undefined as never }) // empty → dropped
    messages.push({ role: 'assistant', content: { not: 'array' } as never, timestamp: undefined as never })
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ messages }) } as unknown as Response)
    const r = await collectSessions('http://gw', 'tok')
    expect(r[0].recentMessages).toHaveLength(5)
    expect(r[0].recentMessages?.[4]).toMatchObject({ content: 'm7', timestamp: '2026-01-01T00:00:07Z' })
  })

  it('returns [] recent messages when history is non-ok or has no items', async () => {
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [{ key: 'k' }] }))
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as unknown as Response)
    expect((await collectSessions('http://gw', 'tok'))[0].recentMessages).toEqual([])
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as unknown as Response)
    expect((await collectSessions('http://gw', 'tok'))[0].recentMessages).toEqual([])
  })
})
