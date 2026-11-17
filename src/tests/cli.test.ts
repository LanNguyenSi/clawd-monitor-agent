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

  it('parses --token-file as its own key, separate from --token', () => {
    process.argv = ['node', 'cli', '--server', 'http://s', '--token-file', '/etc/clawd-monitor-agent/token']
    const result = parseArgs()
    expect(result['token-file']).toBe('/etc/clawd-monitor-agent/token')
    expect(result.token).toBeUndefined()
  })

  it('parses --gateway-token-file as its own key, separate from --gateway-token', () => {
    process.argv = ['node', 'cli', '--server', 'http://s', '--gateway-token-file', '/etc/clawd-monitor-agent/gateway-token']
    const result = parseArgs()
    expect(result['gateway-token-file']).toBe('/etc/clawd-monitor-agent/gateway-token')
    expect(result['gateway-token']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // --token-file / --gateway-token-file without a value → exit(1)
  // -------------------------------------------------------------------------
  const expectMissingValueExit = (argv: string[], flag: string) => {
    process.argv = ['node', 'cli', ...argv]
    const errors: string[] = []
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
    try {
      expect(() => parseArgs()).toThrow('exit:1')
    } finally {
      err.mockRestore()
    }
    expect(errors.join('\n')).toContain(flag)
  }

  it('exits 1 when --token-file is the last argument', () => {
    expectMissingValueExit(['--server', 'http://s', '--token-file'], '--token-file')
  })

  it('exits 1 when --token-file is followed by another flag', () => {
    expectMissingValueExit(['--token-file', '--server', 'http://s'], '--token-file')
  })

  it('exits 1 when --gateway-token-file is the last argument', () => {
    expectMissingValueExit(['--server', 'http://s', '--gateway-token-file'], '--gateway-token-file')
  })

  it('exits 1 when --gateway-token-file is followed by another flag', () => {
    expectMissingValueExit(['--gateway-token-file', '--debug'], '--gateway-token-file')
  })

  it('exits 1 for --token-file with an empty-string value', () => {
    expectMissingValueExit(['--server', 'http://s', '--token-file', ''], '--token-file')
  })

  it('still parses a path value for --token-file and --gateway-token-file', () => {
    process.argv = ['node', 'cli', '--token-file', '/etc/cma/token', '--gateway-token-file', '/etc/cma/gateway-token']
    const result = parseArgs()
    expect(result['token-file']).toBe('/etc/cma/token')
    expect(result['gateway-token-file']).toBe('/etc/cma/gateway-token')
  })

  it('takes a value that starts with a single dash as the path', () => {
    process.argv = ['node', 'cli', '--token-file', '-h', '--gateway-token-file', '-tok']
    const result = parseArgs()
    expect(result['token-file']).toBe('-h')
    expect(result['gateway-token-file']).toBe('-tok')
  })

  it('--help lists --gateway-token-file, marks --gateway-token deprecated and states the Gateway token precedence', () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    try {
      process.argv = ['node', 'cli', '--help']
      expect(() => parseArgs()).toThrow('exit:0')
    } finally {
      log.mockRestore()
    }
    const help = lines.join('\n')
    expect(help).toMatch(/--gateway-token-file <path>\s+File holding the OpenClaw Gateway API token/)
    expect(help).toMatch(/--gateway-token <token>\s+.*deprecated/)
    expect(help).toMatch(/--gateway-token-file,\s+the OPENCLAW_GATEWAY_TOKEN environment variable,\s+--gateway-token, "gateway.token" in --config/)
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
