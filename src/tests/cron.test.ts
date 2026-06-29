import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node:child_process (used by cron.ts)
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
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
    vi.mocked(execSync).mockReset()
  })

  // -------------------------------------------------------------------------
  // Happy path: valid JSON array
  // -------------------------------------------------------------------------
  it('returns mapped jobs from valid JSON output', async () => {
    vi.mocked(execSync).mockReturnValue(
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
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ jobs }))

    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('job-2')
    expect(result[1].enabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Non-array jobs field → guard returns []
  // -------------------------------------------------------------------------
  it('returns [] when jobs field is not an array', async () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ jobs: 'invalid' }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  it('returns [] when jobs field is absent', async () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ other: 'data' }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // execSync throws → catch → []
  // -------------------------------------------------------------------------
  it('returns [] when execSync throws (command not found)', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('openclaw: command not found')
    })
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  it('returns [] on JSON parse error from stdout', async () => {
    vi.mocked(execSync).mockReturnValue('{not valid json')
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Empty jobs array
  // -------------------------------------------------------------------------
  it('returns [] when jobs array is empty', async () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({ jobs: [] }))
    const result = await collectCronJobs('http://localhost:18789')
    expect(result).toEqual([])
  })
})
