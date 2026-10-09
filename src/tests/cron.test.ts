import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the openclaw CLI runner (used by cron.ts)
// ---------------------------------------------------------------------------
vi.mock('../collectors/cli.js', async (orig) => ({
  ...(await orig<typeof import('../collectors/cli.js')>()),
  runOpenclaw: vi.fn(),
}))

import { runOpenclaw as execSync } from '../collectors/cli.js'
import { clearCache } from '../collectors/cache.js'
import { collectCronJobs } from '../collectors/cron.js'

// ---------------------------------------------------------------------------
// Sample job fixture
// ---------------------------------------------------------------------------
const sampleJob = {
  id: 'job-1',
  name: 'My Job',
  schedule: { cron: '0 * * * *' },
  enabled: true,
  state: { lastRunAtMs: 1700000000000, nextRunAtMs: 1700003600000 },
}

describe('collectCronJobs', () => {
  beforeEach(() => {
    clearCache()
    vi.mocked(execSync).mockReset()
  })

  // -------------------------------------------------------------------------
  // Happy path: valid JSON array
  // -------------------------------------------------------------------------
  it('returns mapped jobs from valid JSON output', async () => {
    vi.mocked(execSync).mockResolvedValue(
      JSON.stringify({ jobs: [sampleJob] })
    )

    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('job-1')
    expect(result[0].name).toBe('My Job')
    expect(result[0].enabled).toBe(true)
    expect(result[0].state?.lastRunAtMs).toBe(1700000000000)
  })

  it('returns all fields from the CLI response', async () => {
    const jobs = [sampleJob, { id: 'job-2', name: 'Job 2', schedule: {}, enabled: false }]
    vi.mocked(execSync).mockResolvedValue(JSON.stringify({ jobs }))

    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('job-2')
    expect(result[1].enabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Non-array jobs field → guard returns []
  // -------------------------------------------------------------------------
  it('returns [] when jobs field is not an array', async () => {
    vi.mocked(execSync).mockResolvedValue(JSON.stringify({ jobs: 'invalid' }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  it('returns [] when jobs field is absent', async () => {
    vi.mocked(execSync).mockResolvedValue(JSON.stringify({ other: 'data' }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // execSync throws → catch → []
  // -------------------------------------------------------------------------
  it('returns [] when execSync throws (command not found)', async () => {
    vi.mocked(execSync).mockRejectedValue(new Error('openclaw: command not found'))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  it('returns [] on JSON parse error from stdout', async () => {
    vi.mocked(execSync).mockResolvedValue('{not valid json')
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Empty jobs array
  // -------------------------------------------------------------------------
  it('returns [] when jobs array is empty', async () => {
    vi.mocked(execSync).mockResolvedValue(JSON.stringify({ jobs: [] }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  it('falls back to displayName and drops unknown state fields', async () => {
    vi.mocked(execSync).mockResolvedValue(
      'log line\n' + JSON.stringify({ jobs: [{ id: 'j', displayName: 'Disp', schedule: {}, enabled: true, status: 'idle', state: { nextRunAtMs: 5, lastRunStatus: 'ok', lastError: 'e', extra: 1 } }] }),
    )
    const r = await collectCronJobs('http://localhost:18789')
    expect(r[0]).toMatchObject({ name: 'Disp', status: 'idle', state: { nextRunAtMs: 5, lastRunStatus: 'ok', lastError: 'e' } })
    expect(r[0].state).not.toHaveProperty('extra')
  })

  it('keeps state undefined when the job has none', async () => {
    vi.mocked(execSync).mockResolvedValue(JSON.stringify({ jobs: [{ id: 'j', schedule: {}, enabled: true }] }))
    expect((await collectCronJobs('x'))[0].state).toBeUndefined()
  })
})
