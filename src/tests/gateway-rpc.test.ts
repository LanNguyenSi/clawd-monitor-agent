import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { withGatewayRpc, toWsUrl, GatewayRpcError } from '../collectors/gateway-rpc.js'

type Handler = (method: string, params: Record<string, unknown>, id: string, send: (f: object) => void) => void

let wss: WebSocketServer | undefined
let connectParams: Record<string, unknown> | undefined

/** Fake Gateway: sends connect.challenge, answers connect, then delegates to `handler`. */
async function startGateway(opts: { handler?: Handler; connectOk?: boolean; noChallenge?: boolean } = {}) {
  connectParams = undefined
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss!.once('listening', r))
  wss.on('connection', (ws) => {
    const send = (f: object) => ws.send(JSON.stringify(f))
    if (!opts.noChallenge) send({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: 1 } })
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.method === 'connect') {
        connectParams = f.params
        if (opts.connectOk === false) {
          send({ type: 'res', id: f.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } })
        } else {
          send({ type: 'res', id: f.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } })
        }
      } else {
        opts.handler?.(f.method, f.params, f.id, send)
      }
    })
  })
  return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (wss) {
    for (const c of wss.clients) c.terminate()
    await new Promise((r) => wss!.close(r))
    wss = undefined
  }
})

describe('toWsUrl', () => {
  it('maps http(s) to ws(s) and keeps ws(s)', () => {
    expect(toWsUrl('http://localhost:18789')).toBe('ws://localhost:18789/')
    expect(toWsUrl('https://gw.example')).toBe('wss://gw.example/')
    expect(toWsUrl('wss://gw.example/x')).toBe('wss://gw.example/x')
    expect(toWsUrl('ws://h:1')).toBe('ws://h:1/')
  })
})

describe('withGatewayRpc', () => {
  it('performs the handshake with token, backend identity and read scope, then calls methods', async () => {
    const url = await startGateway({
      handler: (m, p, id, send) => send({ type: 'res', id, ok: true, payload: { echoed: m, p } }),
    })
    const out = await withGatewayRpc(url, 'secret', (call) => call<{ echoed: string; p: unknown }>('sessions.list', { limit: 3 }))
    expect(out).toEqual({ echoed: 'sessions.list', p: { limit: 3 } })
    expect(connectParams).toMatchObject({
      minProtocol: 3,
      maxProtocol: 4,
      role: 'operator',
      scopes: ['operator.read'],
      auth: { token: 'secret' },
      client: { id: 'gateway-client', mode: 'backend' },
    })
  })

  it('supports several concurrent calls on one connection', async () => {
    const url = await startGateway({
      handler: (m, _p, id, send) => setTimeout(() => send({ type: 'res', id, ok: true, payload: m }), m === 'slow' ? 30 : 0),
    })
    const r = await withGatewayRpc(url, 't', (call) => Promise.all([call('slow'), call('fast')]))
    expect(r).toEqual(['slow', 'fast'])
  })

  it('ignores malformed frames and unrelated responses', async () => {
    const url = await startGateway({
      handler: (_m, _p, id, send) => {
        send({ type: 'res', id: 'unknown', ok: true })
        send({ type: 'event', event: 'tick' })
        send({ type: 'res', id, ok: true, payload: 'fine' })
      },
    })
    expect(await withGatewayRpc(url, 't', (call) => call('x'))).toBe('fine')
  })

  it('rejects with the gateway error code when connect is refused', async () => {
    const url = await startGateway({ connectOk: false })
    await expect(withGatewayRpc(url, 'bad', async () => 1)).rejects.toMatchObject({ name: 'GatewayRpcError', code: 'UNAUTHORIZED', message: 'bad token' })
  })

  it('surfaces RPC errors and falls back to a generic message', async () => {
    const url = await startGateway({
      handler: (m, _p, id, send) =>
        send(m === 'a'
          ? { type: 'res', id, ok: false, error: { code: 'FORBIDDEN', message: 'missing scope' } }
          : { type: 'res', id, ok: false }),
    })
    await expect(withGatewayRpc(url, 't', (call) => call('a'))).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'missing scope' })
    await expect(withGatewayRpc(url, 't', (call) => call('b'))).rejects.toThrow('b failed')
  })

  it('times out a request that never answers', async () => {
    const url = await startGateway({ handler: () => {} })
    await expect(withGatewayRpc(url, 't', (call) => call('hang'), { requestTimeoutMs: 80 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('times out when the gateway never sends a challenge', async () => {
    const url = await startGateway({ noChallenge: true })
    await expect(withGatewayRpc(url, 't', async () => 1, { connectTimeoutMs: 80 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects when nothing is listening', async () => {
    await expect(withGatewayRpc('http://127.0.0.1:1', 't', async () => 1, { connectTimeoutMs: 500 })).rejects.toBeInstanceOf(GatewayRpcError)
  })

  it('rejects in-flight requests when the socket drops', async () => {
    const url = await startGateway({ handler: () => { for (const c of wss!.clients) c.terminate() } })
    await expect(withGatewayRpc(url, 't', (call) => call('x'))).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('closes the connection after fn resolves', async () => {
    const url = await startGateway({})
    await withGatewayRpc(url, 't', async () => 'ok')
    await new Promise((r) => setTimeout(r, 50))
    expect(wss!.clients.size).toBe(0)
  })
})
