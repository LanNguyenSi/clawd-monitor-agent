import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that trigger module load
// ---------------------------------------------------------------------------
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('crypto', () => ({
  randomUUID: vi.fn(),
}))

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { loadConfig } from '../config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type ReadFileSyncFn = (path: Parameters<typeof readFileSync>[0], enc?: BufferEncoding) => string

/** Returns a readFileSync mock that serves a valid /etc/hostname by default. */
function makeReadFileMock(
  overrides: Record<string, string | (() => string | never)> = {}
): ReadFileSyncFn {
  return (path, _enc) => {
    const p = String(path)
    if (p in overrides) {
      const v = overrides[p]
      if (typeof v === 'function') return (v as () => string)()
      return v
    }
    if (p === '/etc/hostname') return 'test-host\n'
    throw new Error(`Unexpected readFileSync(${p})`)
  }
}

// Minimal valid CLI args
const VALID_ARGS = { server: 'http://s.example.com', token: 'my-token' }

describe('loadConfig', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset()
    vi.mocked(writeFileSync).mockReset()
    vi.mocked(existsSync).mockReset()
    vi.mocked(randomUUID).mockReset()

    // Default: no agent-id file; randomUUID returns a predictable value
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(randomUUID).mockReturnValue('generated-uuid' as unknown as `${string}-${string}-${string}-${string}-${string}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(readFileSync).mockImplementation(makeReadFileMock() as any)

    // Suppress process.exit to avoid crashing the test process
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code ?? 0}`)
    })
  })

  // -------------------------------------------------------------------------
  // getOrCreateAgentId: existing file → trimmed content, no write
  // -------------------------------------------------------------------------
  describe('getOrCreateAgentId', () => {
    it('returns trimmed file content when agent-id file exists', () => {
      vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('.clawd-agent-id'))
      // When existsSync returns true for AGENT_ID_FILE, readFileSync is called for it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        const p = String(path)
        if (p.endsWith('.clawd-agent-id')) return '  existing-id-1234  \n'
        if (p === '/etc/hostname') return 'test-host\n'
        throw new Error(`Unexpected readFileSync(${p})`)
      })

      const config = loadConfig(VALID_ARGS)
      expect(config.agentId).toBe('existing-id-1234')
      expect(writeFileSync).not.toHaveBeenCalled()
    })

    it('creates a new agent-id file with mode 0o600 when file is absent', () => {
      vi.mocked(existsSync).mockReturnValue(false)

      const config = loadConfig(VALID_ARGS)
      expect(config.agentId).toBe('generated-uuid')

      // Assert writeFileSync was called with { mode: 0o600 }
      const calls = vi.mocked(writeFileSync).mock.calls
      expect(calls).toHaveLength(1)
      const [writePath, writeContent, writeOpts] = calls[0]
      expect(String(writePath)).toMatch(/.clawd-agent-id$/)
      expect(writeContent).toBe('generated-uuid')
      expect(writeOpts).toMatchObject({ mode: 0o600 })
    })
  })

  // -------------------------------------------------------------------------
  // Config file: bad JSON → exit(1)
  // -------------------------------------------------------------------------
  describe('--config flag', () => {
    it('exits with code 1 on bad JSON in config file', () => {
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        const p = String(path)
        if (p === 'bad.json') return '{not valid json'
        if (p === '/etc/hostname') return 'test-host\n'
        throw new Error(`Unexpected: ${p}`)
      })

      expect(() => loadConfig({ config: 'bad.json', ...VALID_ARGS })).toThrow('exit:1')
    })

    it('loads server and token from config file', () => {
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        const p = String(path)
        if (p === 'cfg.json') return JSON.stringify({ server: 'http://from-file', token: 'file-token' })
        if (p === '/etc/hostname') return 'test-host\n'
        throw new Error(`Unexpected: ${p}`)
      })

      const config = loadConfig({ config: 'cfg.json' })
      expect(config.server).toBe('http://from-file')
      expect(config.token).toBe('file-token')
    })
  })

  // -------------------------------------------------------------------------
  // Required fields
  // -------------------------------------------------------------------------
  describe('required field validation', () => {
    it('exits with code 1 when server is missing', () => {
      expect(() => loadConfig({ token: 'tok' })).toThrow('exit:1')
    })

    it('exits with code 1 when token is missing', () => {
      expect(() => loadConfig({ server: 'http://s.example.com' })).toThrow('exit:1')
    })
  })

  // -------------------------------------------------------------------------
  // Interval clamp
  // -------------------------------------------------------------------------
  describe('intervalMs', () => {
    it('clamps interval below 1000 to 1000', () => {
      const config = loadConfig({ ...VALID_ARGS, interval: '500' })
      expect(config.intervalMs).toBe(1000)
    })

    it('accepts intervals above 1000 verbatim', () => {
      const config = loadConfig({ ...VALID_ARGS, interval: '10000' })
      expect(config.intervalMs).toBe(10000)
    })

    it('uses fileConfig.intervalMs when interval arg is absent', () => {
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        const p = String(path)
        if (p === 'cfg.json') return JSON.stringify({ server: 'http://s', token: 't', intervalMs: 7500 })
        if (p === '/etc/hostname') return 'test-host\n'
        throw new Error(`Unexpected: ${p}`)
      })
      const config = loadConfig({ config: 'cfg.json' })
      expect(config.intervalMs).toBe(7500)
    })

    it('defaults to 5000 when neither arg nor file provides it', () => {
      const config = loadConfig(VALID_ARGS)
      expect(config.intervalMs).toBe(5000)
    })
  })

  // -------------------------------------------------------------------------
  // collect flags
  // -------------------------------------------------------------------------
  describe('collect flags', () => {
    it('forces collect.memory=false when args.memory===false', () => {
      const config = loadConfig({ ...VALID_ARGS, memory: false })
      expect(config.collect.memory).toBe(false)
    })

    it('forces collect.docker=false when args.docker===false', () => {
      const config = loadConfig({ ...VALID_ARGS, docker: false })
      expect(config.collect.docker).toBe(false)
    })

    it('defaults collect.memory and collect.docker to true when args are undefined', () => {
      const config = loadConfig(VALID_ARGS)
      expect(config.collect.memory).toBe(true)
      expect(config.collect.docker).toBe(true)
    })

    it('args.memory=false overrides fileConfig.collect.memory=true', () => {
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        const p = String(path)
        if (p === 'cfg.json')
          return JSON.stringify({ server: 'http://s', token: 't', collect: { memory: true } })
        if (p === '/etc/hostname') return 'test-host\n'
        throw new Error(`Unexpected: ${p}`)
      })
      const config = loadConfig({ config: 'cfg.json', memory: false })
      expect(config.collect.memory).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Hostname fallback
  // -------------------------------------------------------------------------
  describe('hostname fallback', () => {
    it('falls back to "unknown" when /etc/hostname read throws', () => {
      vi.mocked(readFileSync).mockImplementation((path, _enc) => {
        if (String(path) === '/etc/hostname') throw new Error('ENOENT')
        throw new Error(`Unexpected: ${path}`)
      })
      const config = loadConfig(VALID_ARGS)
      expect(config.name).toBe('unknown')
    })

    it('uses hostname from /etc/hostname when readable', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(readFileSync).mockImplementation(makeReadFileMock() as any)
      const config = loadConfig(VALID_ARGS)
      expect(config.name).toBe('test-host')
    })

    it('args.name overrides hostname', () => {
      const config = loadConfig({ ...VALID_ARGS, name: 'my-name' })
      expect(config.name).toBe('my-name')
    })
  })

  // -------------------------------------------------------------------------
  // logLevel
  // -------------------------------------------------------------------------
  describe('logLevel', () => {
    it('sets logLevel to "debug" when args.debug is true', () => {
      const config = loadConfig({ ...VALID_ARGS, debug: true })
      expect(config.logLevel).toBe('debug')
    })

    it('defaults logLevel to "info"', () => {
      const config = loadConfig(VALID_ARGS)
      expect(config.logLevel).toBe('info')
    })
  })
})
