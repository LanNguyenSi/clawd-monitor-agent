import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock all five collector modules
// ---------------------------------------------------------------------------
vi.mock('../collectors/sessions.js', () => ({
  collectSessions: vi.fn(),
}))
vi.mock('../collectors/cron.js', () => ({
  collectCronJobs: vi.fn(),
}))
vi.mock('../collectors/metrics.js', () => ({
  collectMetrics: vi.fn(),
}))
vi.mock('../collectors/memory.js', () => ({
  collectMemory: vi.fn(),
}))
vi.mock('../collectors/docker.js', () => ({
  collectDocker: vi.fn(),
}))

import { collectSessions } from '../collectors/sessions.js'
import { collectCronJobs } from '../collectors/cron.js'
import { collectMetrics } from '../collectors/metrics.js'
import { collectMemory } from '../collectors/memory.js'
import { collectDocker } from '../collectors/docker.js'
import { collectSnapshot } from '../collectors/index.js'
import type { AgentConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<AgentConfig['collect']> = {}): AgentConfig {
  return {
    server: 'http://s',
    token: 'tok',
    agentId: 'agent-123',
    name: 'agent-name',
    gateway: { url: 'http://gw', token: undefined },
    clawd_dir: '/tmp/clawd',
    collect: {
      sessions: true,
      cron: true,
      metrics: true,
      memory: true,
      docker: true,
      ...overrides,
    },
    intervalMs: 5000,
    logLevel: 'info',
  }
}

const defaultMetrics = { cpuPercent: 5, memUsedBytes: 100, memTotalBytes: 1000, uptimeSeconds: 300 }
const defaultMemory = { memory: '# Mem' }
const defaultSession = { sessionKey: 'sk1', kind: 'main' }
const defaultCron = { id: 'c1', schedule: {}, enabled: true }
const defaultContainer = { id: 'abc', name: 'web', image: 'nginx', state: 'running' as const, restarts: 0, uptime: '1h' }

describe('collectSnapshot', () => {
  beforeEach(() => {
    vi.mocked(collectSessions).mockReset()
    vi.mocked(collectCronJobs).mockReset()
    vi.mocked(collectMetrics).mockReset()
    vi.mocked(collectMemory).mockReset()
    vi.mocked(collectDocker).mockReset()

    // Defaults for all collectors
    vi.mocked(collectSessions).mockResolvedValue([defaultSession])
    vi.mocked(collectCronJobs).mockResolvedValue([defaultCron])
    vi.mocked(collectMetrics).mockReturnValue(defaultMetrics)
    vi.mocked(collectMemory).mockReturnValue(defaultMemory)
    vi.mocked(collectDocker).mockReturnValue([defaultContainer])
  })

  // -------------------------------------------------------------------------
  // Envelope fields
  // -------------------------------------------------------------------------
  it('includes agentId, name, version, and a numeric timestamp', async () => {
    const config = makeConfig()
    const snapshot = await collectSnapshot(config)

    expect(snapshot.agentId).toBe('agent-123')
    expect(snapshot.name).toBe('agent-name')
    expect(typeof snapshot.version).toBe('string')
    expect(typeof snapshot.timestamp).toBe('number')
    expect(snapshot.timestamp).toBeGreaterThan(0)
  })

  it('includes all collector arrays in the envelope', async () => {
    const snapshot = await collectSnapshot(makeConfig())

    expect(snapshot.sessions).toEqual([defaultSession])
    expect(snapshot.cronJobs).toEqual([defaultCron])
    expect(snapshot.metrics).toEqual(defaultMetrics)
    expect(snapshot.memoryFiles).toEqual(defaultMemory)
    expect(snapshot.containers).toEqual([defaultContainer])
  })

  // -------------------------------------------------------------------------
  // collect.sessions = false → collectSessions not called
  // -------------------------------------------------------------------------
  it('skips sessions when collect.sessions is false', async () => {
    const snapshot = await collectSnapshot(makeConfig({ sessions: false }))
    expect(collectSessions).not.toHaveBeenCalled()
    expect(snapshot.sessions).toEqual([])
  })

  // -------------------------------------------------------------------------
  // collect.cron = false → collectCronJobs not called
  // -------------------------------------------------------------------------
  it('skips cron when collect.cron is false', async () => {
    const snapshot = await collectSnapshot(makeConfig({ cron: false }))
    expect(collectCronJobs).not.toHaveBeenCalled()
    expect(snapshot.cronJobs).toEqual([])
  })

  // -------------------------------------------------------------------------
  // collect.metrics = false → zero metrics
  // -------------------------------------------------------------------------
  it('returns zero metrics when collect.metrics is false', async () => {
    const snapshot = await collectSnapshot(makeConfig({ metrics: false }))
    expect(collectMetrics).not.toHaveBeenCalled()
    expect(snapshot.metrics.cpuPercent).toBe(0)
    expect(snapshot.metrics.memUsedBytes).toBe(0)
  })

  // -------------------------------------------------------------------------
  // collect.memory = false → empty memoryFiles
  // -------------------------------------------------------------------------
  it('returns empty memoryFiles when collect.memory is false', async () => {
    const snapshot = await collectSnapshot(makeConfig({ memory: false }))
    expect(collectMemory).not.toHaveBeenCalled()
    expect(snapshot.memoryFiles).toEqual({})
  })

  // -------------------------------------------------------------------------
  // collect.docker = false → empty containers
  // -------------------------------------------------------------------------
  it('returns empty containers when collect.docker is false', async () => {
    const snapshot = await collectSnapshot(makeConfig({ docker: false }))
    expect(collectDocker).not.toHaveBeenCalled()
    expect(snapshot.containers).toEqual([])
  })

  // -------------------------------------------------------------------------
  // All collectors are called when all toggles are true
  // -------------------------------------------------------------------------
  it('calls all collectors when all toggles are true', async () => {
    await collectSnapshot(makeConfig())
    expect(collectSessions).toHaveBeenCalledOnce()
    expect(collectCronJobs).toHaveBeenCalledOnce()
    expect(collectMetrics).toHaveBeenCalledOnce()
    expect(collectMemory).toHaveBeenCalledOnce()
    expect(collectDocker).toHaveBeenCalledOnce()
  })
})
