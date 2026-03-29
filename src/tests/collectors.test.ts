import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}))

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { collectMemory } from '../collectors/memory.js'
import { collectMetrics } from '../collectors/metrics.js'
import { collectDocker } from '../collectors/docker.js'

describe('collectMemory', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset()
    vi.mocked(readFileSync).mockReset()
  })

  it('returns undefined for missing files', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = collectMemory('/test/clawd')
    expect(result.memory).toBeUndefined()
    expect(result.current).toBeUndefined()
    expect(result.today).toBeUndefined()
  })

  it('reads MEMORY.md when it exists', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('MEMORY.md'))
    vi.mocked(readFileSync).mockReturnValue('# Memory content')
    const result = collectMemory('/test/clawd')
    expect(result.memory).toBe('# Memory content')
  })

  it('truncates files over 10KB', () => {
    const bigContent = 'x'.repeat(11 * 1024)
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(bigContent)
    const result = collectMemory('/test/clawd')
    expect(result.memory).toContain('[... truncated ...]')
    expect((result.memory ?? '').length).toBeLessThan(bigContent.length)
  })

  it('never reads outside clawd_dir', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('content')
    collectMemory('/test/clawd')
    const calls = vi.mocked(readFileSync).mock.calls
    for (const [path] of calls) {
      expect(String(path)).toMatch(/^\/test\/clawd/)
    }
  })
})

describe('collectMetrics', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
  })

  it('returns zeros when /proc/stat is unavailable', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    const result = collectMetrics()
    expect(result.cpuPercent).toBe(0)
    expect(result.memUsedBytes).toBe(0)
    expect(result.memTotalBytes).toBe(0)
  })

  it('parses /proc/meminfo correctly', () => {
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path) === '/proc/stat') return 'cpu 100 0 50 800 0 0 0 0 0 0'
      if (String(path) === '/proc/meminfo') return 'MemTotal: 8192 kB\nMemFree: 2048 kB\nBuffers: 512 kB\nCached: 1024 kB\n'
      if (String(path) === '/proc/uptime') return '3600.00 7200.00'
      throw new Error('ENOENT')
    })
    const result = collectMetrics()
    expect(result.memTotalBytes).toBe(8192 * 1024)
    expect(result.uptimeSeconds).toBe(3600)
  })
})

describe('collectDocker', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset()
  })

  it('returns empty array when docker is unavailable', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('docker: command not found') })
    expect(collectDocker()).toEqual([])
  })

  it('parses docker ps output correctly', () => {
    vi.mocked(execSync).mockReturnValue(
      'abc123def456\tmy-app\tnginx\tUp 2 hours (1)\trunning\t2 hours ago\n'
    )
    const result = collectDocker()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('my-app')
    expect(result[0].state).toBe('running')
    expect(result[0].restarts).toBe(1)
    expect(result[0].image).toBe('nginx')
  })

  it('handles unknown container state gracefully', () => {
    vi.mocked(execSync).mockReturnValue('abc\tcontainer\timage\tStatus\tcreated\t1h ago\n')
    const result = collectDocker()
    expect(result[0].state).toBe('unknown')
  })
})
