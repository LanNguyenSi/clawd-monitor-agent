import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../collectors/cli.js', async (orig) => ({
  ...(await orig<typeof import('../collectors/cli.js')>()),
  runOpenclaw: vi.fn(),
}))
vi.mock('../collectors/gateway-rpc.js', () => ({ withGatewayRpc: vi.fn() }))
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockRejectedValue(new Error('ENOENT')),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

import { runOpenclaw } from '../collectors/cli.js'
import { clearCache } from '../collectors/cache.js'
import { withGatewayRpc } from '../collectors/gateway-rpc.js'
import { collectSessions } from '../collectors/sessions.js'

const cliPayload = {
  sessions: [
    { key: 'agent:main:old', kind: 'direct', model: 'a', updatedAt: 1000, status: 'done' },
    { key: 'agent:main:main', kind: 'direct', model: 'claude-sonnet-5-5', updatedAt: 2000, status: 'running', totalTokens: 31872 },
  ],
}

describe('collectSessions (openclaw sessions CLI)', () => {
  beforeEach(() => {
    clearCache()
    vi.mocked(withGatewayRpc).mockReset().mockRejectedValue(new Error('no gateway'))
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
    clearCache()
    vi.mocked(withGatewayRpc).mockReset().mockRejectedValue(new Error('no gateway'))
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
    clearCache()
    vi.mocked(withGatewayRpc).mockReset().mockRejectedValue(new Error('no gateway'))
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

describe('collectSessions via Gateway RPC', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    clearCache()
    vi.mocked(runOpenclaw).mockReset()
    vi.mocked(withGatewayRpc).mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  const rows = [
    { key: 'a', kind: 'direct', model: 'm', updatedAt: 1000, status: 'done', totalTokens: 5 },
    { key: 'b', kind: 'direct', model: 'm', updatedAt: 2000, status: 'running' },
  ]
  function fakeGateway(handlers: Record<string, unknown>) {
    vi.mocked(withGatewayRpc).mockImplementation((async (_u: string, _t: string, fn: (c: unknown) => unknown) =>
      fn(async (method: string, params?: unknown) => {
        const h = handlers[method]
        if (h instanceof Error) throw h
        calls.push([method, params])
        return h
      })) as never)
  }
  const calls: Array<[string, unknown]> = []
  beforeEach(() => { calls.length = 0 })

  it('lists sessions and fills previews with one bulk call, never touching the CLI', async () => {
    fakeGateway({
      'sessions.list': { sessions: rows },
      'sessions.preview': {
        previews: [
          { key: 'b', status: 'ok', items: [{ role: 'user', text: 'hi' }, { role: 'custom', text: 'x' }, { role: 'assistant', text: 'yo' }, { role: 'assistant', text: '' }] },
          { key: 'a', status: 'cold', items: [] },
        ],
      },
    })
    const r = await collectSessions('http://127.0.0.1:18789', 'tok')
    expect(runOpenclaw).not.toHaveBeenCalled()
    expect(vi.mocked(withGatewayRpc).mock.calls[0][0]).toBe('http://127.0.0.1:18789')
    expect(vi.mocked(withGatewayRpc).mock.calls[0][1]).toBe('tok')
    expect(r.map((x) => x.sessionKey)).toEqual(['b', 'a'])
    expect(r[0].recentMessages).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])
    expect(r[1].recentMessages).toEqual([])
    expect(calls.map((c) => c[0])).toEqual(['sessions.list', 'sessions.preview'])
    expect(calls[1][1]).toMatchObject({ keys: ['b', 'a'], limit: 5 })
  })

  it('keeps the rows when previews fail or the list is empty', async () => {
    fakeGateway({ 'sessions.list': { sessions: rows }, 'sessions.preview': new Error('nope') })
    const r = await collectSessions('http://gw', 'tok')
    expect(r).toHaveLength(2)
    expect(r[0].recentMessages).toEqual([])

    calls.length = 0
    fakeGateway({ 'sessions.list': { sessions: [] } })
    expect(await collectSessions('http://gw', 'tok')).toEqual([])
    expect(calls.map((c) => c[0])).toEqual(['sessions.list'])
  })

  it('tolerates a preview payload without previews / items', async () => {
    fakeGateway({ 'sessions.list': { sessions: [rows[0]] }, 'sessions.preview': { previews: [{ key: 'a' }] } })
    expect((await collectSessions('http://gw', 'tok'))[0].recentMessages).toEqual([])
    fakeGateway({ 'sessions.list': { sessions: [rows[0]] }, 'sessions.preview': {} })
    expect((await collectSessions('http://gw', 'tok'))[0].recentMessages).toEqual([])
  })

  it('uses OPENCLAW_GATEWAY_TOKEN when no token is passed', async () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'env-tok')
    fakeGateway({ 'sessions.list': { sessions: [] } })
    await collectSessions('http://gw')
    expect(vi.mocked(withGatewayRpc).mock.calls[0][1]).toBe('env-tok')
  })

  it('falls back to the CLI when the gateway call fails', async () => {
    vi.mocked(withGatewayRpc).mockRejectedValue(new Error('ECONNREFUSED'))
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [rows[1]] }))
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) } as unknown as Response)
    const r = await collectSessions('http://gw', 'tok')
    expect(runOpenclaw).toHaveBeenCalled()
    expect(r[0].sessionKey).toBe('b')
  })

  it('falls back to the CLI when the list payload is malformed', async () => {
    fakeGateway({ 'sessions.list': { nope: 1 } })
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [rows[0]] }))
    expect((await collectSessions('http://gw', 'tok'))[0].sessionKey).toBe('a')
  })

  it('does not attempt the gateway without any token', async () => {
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', '')
    vi.mocked(runOpenclaw).mockResolvedValue(JSON.stringify({ sessions: [rows[0]] }))
    await collectSessions('http://gw')
    expect(withGatewayRpc).not.toHaveBeenCalled()
  })
})
