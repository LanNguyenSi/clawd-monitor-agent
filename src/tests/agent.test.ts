import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted WebSocket mock fixture
// ---------------------------------------------------------------------------
const wsFixture = vi.hoisted(() => {
  let _last: MockWs | null = null
  let _instanceCount = 0

  class MockWs {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    send = vi.fn()
    close = vi.fn()
    removeAllListeners = vi.fn()
    readyState = 1 // OPEN
    static OPEN = 1
    instanceIndex: number

    constructor(_url: string, _opts?: unknown) {
      _last = this
      _instanceCount++
      this.instanceIndex = _instanceCount
    }

    on(event: string, cb: (...a: unknown[]) => void) {
      ;(this.handlers[event] ??= []).push(cb)
    }

    emit(event: string, ...args: unknown[]) {
      this.handlers[event]?.forEach((cb) => cb(...args))
    }
  }

  return {
    MockWs,
    getLast: () => _last,
    getCount: () => _instanceCount,
    reset: () => { _last = null; _instanceCount = 0 },
  }
})

vi.mock('ws', () => ({ default: wsFixture.MockWs }))

// ---------------------------------------------------------------------------
// Collector mock
// ---------------------------------------------------------------------------
vi.mock('../collectors/index.js', () => ({
  collectSnapshot: vi.fn(),
}))

import { collectSnapshot } from '../collectors/index.js'
import { Agent } from '../agent.js'
import type { AgentConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Test config factory
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    server: 'http://localhost:9999',
    token: 'test-token',
    agentId: 'agent-id-abc',
    name: 'test-agent',
    gateway: { url: 'http://localhost:18789', token: 'gw-token' },
    clawd_dir: '/tmp/clawd',
    collect: { sessions: true, cron: true, metrics: true, memory: true, docker: true },
    intervalMs: 5000,
    logLevel: 'error', // suppress noise in tests
    ...overrides,
  }
}

/**
 * Flush enough microtask ticks for an async chain like:
 *   void pushSnapshot()  →  await collectSnapshot()  →  ws.send()
 * to complete. With fake timers, Promise continuations still run as
 * microtasks so multiple Promise.resolve() calls are sufficient.
 */
async function flushMicrotasks(n = 5) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('Agent WebSocket client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsFixture.reset()
    vi.mocked(collectSnapshot).mockReset()
    vi.mocked(collectSnapshot).mockResolvedValue({
      agentId: 'agent-id-abc',
      name: 'test-agent',
      timestamp: 1000,
      version: '0.1.0',
      sessions: [],
      cronJobs: [],
      metrics: { cpuPercent: 0, memUsedBytes: 0, memTotalBytes: 0, uptimeSeconds: 0 },
      memoryFiles: {},
      containers: [],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Auth handshake
  // -------------------------------------------------------------------------
  describe('auth handshake', () => {
    it('sends auth message on open with all config fields', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      expect(ws).toBeDefined()

      ws.emit('open')

      expect(ws.send).toHaveBeenCalledOnce()
      const msg = JSON.parse(ws.send.mock.calls[0][0] as string)
      expect(msg.type).toBe('auth')
      expect(msg.token).toBe('test-token')
      expect(msg.agentId).toBe('agent-id-abc')
      expect(msg.name).toBe('test-agent')
      expect(msg.gatewayUrl).toBe('http://localhost:18789')
      expect(msg.gatewayToken).toBe('gw-token')
      expect(typeof msg.version).toBe('string')

      agent.stop()
    })
  })

  // -------------------------------------------------------------------------
  // Dispatch: auth_ok
  // -------------------------------------------------------------------------
  describe('auth_ok', () => {
    it('starts push loop: collectSnapshot is called for the immediate push', async () => {
      const config = makeConfig({ intervalMs: 5000 })
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.send.mockClear()

      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))
      // startPushLoop calls `void this.pushSnapshot()` immediately.
      // Flush microtasks (Promise chain) without advancing fake timers,
      // so the setInterval doesn't re-fire.
      await flushMicrotasks()

      expect(collectSnapshot).toHaveBeenCalledOnce()

      // Advance exactly one interval — should trigger a second push
      vi.advanceTimersByTime(5000)
      await flushMicrotasks()
      expect(collectSnapshot).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('starts ping loop: ping is sent every 30s', async () => {
      const config = makeConfig({ intervalMs: 5000 })
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))
      await flushMicrotasks()

      ws.send.mockClear()
      vi.advanceTimersByTime(30_000)
      await flushMicrotasks()

      const pings = ws.send.mock.calls.filter((c) => {
        try {
          const m = JSON.parse(c[0] as string) as { type: string }
          return m.type === 'ping'
        } catch { return false }
      })
      expect(pings.length).toBeGreaterThanOrEqual(1)

      agent.stop()
    })

    it('resets reconnectDelay to 1000 on successful auth', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      // Force a non-default reconnect delay
      ;(agent as unknown as { reconnectDelay: number }).reconnectDelay = 8000

      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))

      expect((agent as unknown as { reconnectDelay: number }).reconnectDelay).toBe(1000)

      agent.stop()
    })
  })

  // -------------------------------------------------------------------------
  // Dispatch: auth_error
  // -------------------------------------------------------------------------
  describe('auth_error', () => {
    it('stops agent, closes socket, does not reconnect', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_error', message: 'bad token' }))

      expect(ws.close).toHaveBeenCalled()

      // A real socket fires the 'close' event after close() is called.
      // Emitting it here exercises the close-handler's `if (!this.stopped) scheduleReconnect()`
      // guard — the path that the auth_error handler's `this.stopped = true` must block.
      ws.emit('close', 1006)

      // Advance time: no reconnect should fire because stopped===true
      vi.advanceTimersByTime(60_000)
      expect(wsFixture.getCount()).toBe(1) // only the first ws was ever created
    })
  })

  // -------------------------------------------------------------------------
  // Dispatch: pong / ack — no crash
  // -------------------------------------------------------------------------
  describe('pong and ack', () => {
    it('handles pong without throwing', () => {
      const agent = new Agent(makeConfig())
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      expect(() => ws.emit('message', JSON.stringify({ type: 'pong' }))).not.toThrow()
      agent.stop()
    })

    it('handles ack without throwing', () => {
      const agent = new Agent(makeConfig())
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      expect(() => ws.emit('message', JSON.stringify({ type: 'ack' }))).not.toThrow()
      agent.stop()
    })
  })

  // -------------------------------------------------------------------------
  // Malformed message — swallowed, no throw
  // -------------------------------------------------------------------------
  describe('malformed message', () => {
    it('swallows non-JSON message without throwing', () => {
      const agent = new Agent(makeConfig())
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      expect(() => ws.emit('message', 'NOT JSON {{{')).not.toThrow()
      agent.stop()
    })
  })

  // -------------------------------------------------------------------------
  // Reconnect backoff
  // -------------------------------------------------------------------------
  describe('reconnect backoff', () => {
    it('schedules reconnect after close (not stopped)', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      ws.emit('open')
      // Close without auth_ok to keep it simple
      ws.emit('close', 1006)

      // After 1000ms delay, a new connection should be attempted
      vi.advanceTimersByTime(1000)
      expect(wsFixture.getCount()).toBe(2) // second ws created
    })

    it('doubles reconnect delay on each failed reconnect (no auth reset)', () => {
      // The doubling only persists across reconnects that never receive auth_ok.
      // auth_ok resets the delay to 1000, which is the intended backoff reset.
      const config = makeConfig()
      const agent = new Agent(config)
      const inner = agent as unknown as { reconnectDelay: number }

      agent.start()
      const ws1 = wsFixture.getLast()!
      ws1.emit('open')

      // First disconnect without auth
      ws1.emit('close', 1006)
      expect(inner.reconnectDelay).toBe(2000) // doubled from 1000

      // Advance to trigger reconnect — intentionally skip auth on ws2
      vi.advanceTimersByTime(1000)
      const ws2 = wsFixture.getLast()!
      ws2.emit('open')
      // No auth_ok on ws2 → delay is NOT reset

      // Second disconnect
      ws2.emit('close', 1006)
      expect(inner.reconnectDelay).toBe(4000) // doubled from 2000

      agent.stop()
    })

    it('caps reconnect delay at 60000ms (Math.min guard)', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      const inner = agent as unknown as { reconnectDelay: number }

      // Set delay to value that would double to 64000 — cap should clamp to 60000
      inner.reconnectDelay = 32000

      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('close', 1006) // no auth → delay not reset

      expect(inner.reconnectDelay).toBe(60_000) // capped from 64000

      // Advance enough for the reconnect to fire and close again
      vi.advanceTimersByTime(32_000)
      const ws2 = wsFixture.getLast()!
      ws2.emit('open')
      ws2.emit('close', 1006)

      // Cap must persist: still 60000, not doubled again
      expect(inner.reconnectDelay).toBe(60_000)

      agent.stop()
    })

    it('does not reconnect when stopped', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws = wsFixture.getLast()!
      ws.emit('open')
      agent.stop()
      ws.emit('close', 1000)

      vi.advanceTimersByTime(60_000)
      expect(wsFixture.getCount()).toBe(1) // no second ws
    })
  })

  // -------------------------------------------------------------------------
  // Stale-socket guard
  // -------------------------------------------------------------------------
  describe('stale-socket guard', () => {
    it('ignores close event from an old (replaced) socket', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws1 = wsFixture.getLast()!
      ws1.emit('open')

      // First legitimate close → schedules reconnect
      ws1.emit('close', 1006)
      vi.advanceTimersByTime(1000) // trigger reconnect → ws2 created
      const ws2 = wsFixture.getLast()!
      expect(ws2).not.toBe(ws1)

      // ws1 emits close again (stale): this.ws is now ws2
      const reconnectSpy = vi.spyOn(
        agent as unknown as { scheduleReconnect: () => void },
        'scheduleReconnect'
      )
      ws1.emit('close', 1006)
      expect(reconnectSpy).not.toHaveBeenCalled() // guard returned early

      agent.stop()
    })

    it('ignores error event from an old socket without crashing', () => {
      const config = makeConfig()
      const agent = new Agent(config)
      agent.start()

      const ws1 = wsFixture.getLast()!
      ws1.emit('open')

      // Trigger a reconnect to create ws2
      ws1.emit('close', 1006)
      vi.advanceTimersByTime(1000)
      expect(wsFixture.getCount()).toBe(2)

      // Error from stale ws1 should not crash and not create a third ws
      expect(() => ws1.emit('error', new Error('stale error'))).not.toThrow()
      expect(wsFixture.getCount()).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // pushSnapshot guards
  // -------------------------------------------------------------------------
  describe('pushSnapshot guards', () => {
    it('does not send when not authenticated', async () => {
      const agent = new Agent(makeConfig())
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.send.mockClear() // clear the auth message

      // Call pushSnapshot directly — not authenticated
      await (agent as unknown as { pushSnapshot: () => Promise<void> }).pushSnapshot()
      expect(ws.send).not.toHaveBeenCalled()

      agent.stop()
    })

    it('does not send when readyState is not OPEN', async () => {
      const agent = new Agent(makeConfig())
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))
      // Flush the immediate pushSnapshot from startPushLoop without
      // running the interval (which would create an infinite timer loop)
      await flushMicrotasks()
      ws.send.mockClear()

      ws.readyState = 3 // CLOSING — not OPEN
      await (agent as unknown as { pushSnapshot: () => Promise<void> }).pushSnapshot()

      const snapshotSends = ws.send.mock.calls.filter((c) => {
        try { return (JSON.parse(c[0] as string) as { type: string }).type === 'snapshot' } catch { return false }
      })
      expect(snapshotSends).toHaveLength(0)

      agent.stop()
    })

    it('logs warn and does not throw when collectSnapshot rejects', async () => {
      // The FIRST call (from startPushLoop's immediate push) will reject.
      vi.mocked(collectSnapshot).mockRejectedValueOnce(new Error('collect boom'))
      const logSpy = vi.spyOn(console, 'log')

      const agent = new Agent(makeConfig({ logLevel: 'warn' }))
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))

      // Flush microtasks so the rejecting pushSnapshot completes
      await flushMicrotasks()

      const warnCalls = logSpy.mock.calls.filter((c) =>
        c.some((a) => typeof a === 'string' && a.includes('WARN'))
      )
      expect(warnCalls.length).toBeGreaterThanOrEqual(1)
      const warnMsg = warnCalls[0].join(' ')
      expect(warnMsg).toMatch(/collect|push/i)

      agent.stop()
    })
  })

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------
  describe('stop()', () => {
    it('sets stopped, clears timers, closes ws', async () => {
      const agent = new Agent(makeConfig({ intervalMs: 5000 }))
      agent.start()
      const ws = wsFixture.getLast()!
      ws.emit('open')
      ws.emit('message', JSON.stringify({ type: 'auth_ok' }))
      // Flush the immediate pushSnapshot from startPushLoop
      await flushMicrotasks()

      agent.stop()
      expect(ws.close).toHaveBeenCalled()

      // After stop, advancing timers should NOT trigger additional sends
      ws.send.mockClear()
      vi.advanceTimersByTime(30_000) // would have triggered both push and ping loops
      await flushMicrotasks()

      const snapshotSends = ws.send.mock.calls.filter((c) => {
        try { return (JSON.parse(c[0] as string) as { type: string }).type === 'snapshot' } catch { return false }
      })
      expect(snapshotSends).toHaveLength(0)
    })
  })
})
