import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Gap 6: cli.ts — parseArgs
 *
 * cli.ts previously ran top-level side effects on import (loadConfig, new Agent,
 * agent.start()). A behavior-preserving entrypoint guard was added:
 *   `if (require.main === module) { main() }`
 * This makes parseArgs importable for unit testing without executing the agent.
 *
 * We also mock the heavy modules that cli.ts imports at the top level so that
 * importing cli.ts in this test file stays lightweight.
 */

// Mock agent and config so importing cli.ts does not load real implementations
vi.mock('../agent.js', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}))

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    server: 'http://test',
    name: 'test',
    gateway: { url: 'http://gw' },
    intervalMs: 5000,
    token: 'tok',
    agentId: 'id',
    clawd_dir: '/tmp',
    collect: { sessions: true, cron: true, metrics: true, memory: true, docker: true },
    logLevel: 'info',
  }),
}))

import { parseArgs } from '../cli.js'

describe('parseArgs', () => {
  const originalArgv = process.argv

  beforeEach(() => {
    // Reset argv to a clean slate before each test
    process.argv = ['node', 'clawd-monitor-agent']
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`)
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Boolean flags
  // -------------------------------------------------------------------------
  it('sets debug=true for --debug', () => {
    process.argv = ['node', 'cli', '--debug']
    expect(parseArgs()).toMatchObject({ debug: true })
  })

  it('sets memory=false for --no-memory', () => {
    process.argv = ['node', 'cli', '--no-memory']
    expect(parseArgs()).toMatchObject({ memory: false })
  })

  it('sets docker=false for --no-docker', () => {
    process.argv = ['node', 'cli', '--no-docker']
    expect(parseArgs()).toMatchObject({ docker: false })
  })

  // -------------------------------------------------------------------------
  // --help / --version → exit(0)
  // -------------------------------------------------------------------------
  it('exits 0 for --help', () => {
    process.argv = ['node', 'cli', '--help']
    expect(() => parseArgs()).toThrow('exit:0')
  })

  it('exits 0 for -h', () => {
    process.argv = ['node', 'cli', '-h']
    expect(() => parseArgs()).toThrow('exit:0')
  })

  it('exits 0 for --version', () => {
    process.argv = ['node', 'cli', '--version']
    expect(() => parseArgs()).toThrow('exit:0')
  })

  // -------------------------------------------------------------------------
  // --flag value lookahead (next arg does NOT start with --)
  // -------------------------------------------------------------------------
  it('consumes next arg as value when it does not start with --', () => {
    process.argv = ['node', 'cli', '--server', 'http://localhost:3000']
    const result = parseArgs()
    expect(result.server).toBe('http://localhost:3000')
  })

  it('parses multiple key-value pairs', () => {
    process.argv = ['node', 'cli', '--server', 'http://s', '--token', 'my-tok']
    const result = parseArgs()
    expect(result.server).toBe('http://s')
    expect(result.token).toBe('my-tok')
  })

  // -------------------------------------------------------------------------
  // Lookahead skips when next arg starts with --
  // -------------------------------------------------------------------------
  it('does NOT consume next arg as value when it starts with --', () => {
    // --name followed by --debug → name gets no value; debug is a separate flag
    process.argv = ['node', 'cli', '--server', '--debug']
    const result = parseArgs()
    // '--server' is followed by '--debug' which starts with '--', so server gets no value
    expect(result.server).toBeUndefined()
    // --debug is processed as the next iteration's flag
    expect(result.debug).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Combination of flags and values
  // -------------------------------------------------------------------------
  it('handles mixed boolean flags and value flags together', () => {
    process.argv = ['node', 'cli', '--server', 'http://s', '--token', 'tok', '--debug', '--no-memory']
    const result = parseArgs()
    expect(result.server).toBe('http://s')
    expect(result.token).toBe('tok')
    expect(result.debug).toBe(true)
    expect(result.memory).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Empty argv → empty result
  // -------------------------------------------------------------------------
  it('returns empty object for no args', () => {
    process.argv = ['node', 'cli']
    expect(parseArgs()).toEqual({})
  })
})
