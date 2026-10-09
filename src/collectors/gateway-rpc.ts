import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { VERSION } from '../version.js'

/**
 * Minimal OpenClaw Gateway WebSocket RPC client (protocol v3/v4).
 *
 * Reading sessions and cron jobs through the CLI cold-starts a Node process
 * (~3 s CPU per call). The Gateway already holds this data, so one short-lived
 * authenticated WebSocket answers the same questions in tens of milliseconds.
 *
 * Handshake: server sends a `connect.challenge` event, client answers with a
 * `connect` request (shared-secret token, operator role, read scope only).
 * `gateway-client` / `backend` is the client identity the Gateway allows for
 * headless integrations.
 */

export type RpcCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

export class GatewayRpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'GatewayRpcError'
  }
}

interface Frame {
  type: string
  id?: string
  event?: string
  ok?: boolean
  payload?: unknown
  error?: { code?: string; message?: string }
}

export function toWsUrl(url: string): string {
  const u = new URL(url)
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:'
  return u.toString()
}

export interface RpcOptions {
  /** Budget for connect + handshake. */
  connectTimeoutMs?: number
  /** Budget per RPC. */
  requestTimeoutMs?: number
}

/**
 * Open a connection, run `fn` with a `call` function, always close.
 * Rejects with GatewayRpcError on handshake, transport or RPC failures.
 */
export async function withGatewayRpc<T>(
  gatewayUrl: string,
  token: string,
  fn: (call: RpcCall) => Promise<T>,
  opts: RpcOptions = {},
): Promise<T> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 5_000
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000

  const ws = new WebSocket(toWsUrl(gatewayUrl), { handshakeTimeout: connectTimeoutMs })
  const pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void }>()
  let closedErr: Error | null = null

  const failAll = (err: Error) => {
    closedErr = closedErr ?? err
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  const request = (method: string, params: Record<string, unknown> | undefined, timeoutMs: number) =>
    new Promise<Frame>((resolve, reject) => {
      if (closedErr) return reject(closedErr)
      const id = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new GatewayRpcError(`${method} timed out after ${timeoutMs}ms`, 'TIMEOUT'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (f) => { clearTimeout(timer); resolve(f) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        ws.send(JSON.stringify({ type: 'req', id, method, params: params ?? {} }))
      } catch (e) {
        pending.delete(id)
        clearTimeout(timer)
        reject(e as Error)
      }
    })

  const challenge = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GatewayRpcError('no connect.challenge from gateway', 'TIMEOUT')),
      connectTimeoutMs,
    )
    ws.on('message', (data) => {
      let f: Frame
      try {
        f = JSON.parse(data.toString()) as Frame
      } catch {
        return
      }
      if (f.type === 'event' && f.event === 'connect.challenge') {
        clearTimeout(timer)
        resolve()
      } else if (f.type === 'res' && f.id) {
        const p = pending.get(f.id)
        if (p) {
          pending.delete(f.id)
          p.resolve(f)
        }
      }
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      const err = new GatewayRpcError(`gateway socket error: ${e.message}`, 'TRANSPORT')
      failAll(err)
      reject(err)
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      const err = new GatewayRpcError(`gateway socket closed (${code})`, 'CLOSED')
      failAll(err)
      reject(err)
    })
  })

  try {
    await challenge
    const hello = await request(
      'connect',
      {
        minProtocol: 3,
        maxProtocol: 4,
        client: { id: 'gateway-client', version: VERSION, platform: process.platform, mode: 'backend' },
        role: 'operator',
        scopes: ['operator.read'],
        caps: [],
        auth: { token },
        userAgent: `clawd-monitor-agent/${VERSION}`,
      },
      connectTimeoutMs,
    )
    if (!hello.ok) {
      throw new GatewayRpcError(hello.error?.message ?? 'connect rejected', hello.error?.code)
    }

    const call: RpcCall = async <R = unknown>(method: string, params?: Record<string, unknown>) => {
      const res = await request(method, params, requestTimeoutMs)
      if (!res.ok) throw new GatewayRpcError(res.error?.message ?? `${method} failed`, res.error?.code)
      return res.payload as R
    }
    return await fn(call)
  } finally {
    failAll(new GatewayRpcError('connection closed', 'CLOSED'))
    try {
      ws.close()
    } catch { /* already closed */ }
  }
}
