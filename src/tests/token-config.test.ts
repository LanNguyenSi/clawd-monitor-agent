import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../config.js'
import { TOKEN_ENV_VAR } from '../token.js'

// loadConfig with real files: the token resolution wired through the config
// loader, including the exit paths. agentId is set in the config file so the
// test never touches the home directory.

let dir: string
let cfgPath: string
let errors: string[]

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(cfgPath, JSON.stringify({ server: 'http://s', agentId: 'test-agent', ...extra }))
}

function tokenFile(content: string, mode = 0o600): string {
  const p = join(dir, 'token')
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clawd-token-cfg-'))
  cfgPath = join(dir, 'config.json')
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`exit:${code ?? 0}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[TOKEN_ENV_VAR]
  rmSync(dir, { recursive: true, force: true })
})

describe('loadConfig token sources', () => {
  it('reads the token from --token-file', () => {
    writeConfig()
    expect(loadConfig({ config: cfgPath, 'token-file': tokenFile('file-token\n') }, {}).token).toBe('file-token')
  })

  it('reads the token from the environment variable', () => {
    writeConfig()
    expect(loadConfig({ config: cfgPath }, { [TOKEN_ENV_VAR]: 'env-token' }).token).toBe('env-token')
  })

  it('still accepts --token, with a deprecation warning on stderr', () => {
    writeConfig()
    expect(loadConfig({ config: cfgPath, token: 'flag-token' }, {}).token).toBe('flag-token')
    expect(errors.join('\n')).toMatch(/--token is deprecated/)
  })

  it('still accepts the token key of the config file (what install.sh wrote before)', () => {
    writeConfig({ token: 'config-token' })
    expect(loadConfig({ config: cfgPath }, {}).token).toBe('config-token')
    expect(errors).toEqual([])
  })

  it('precedence: --token-file, then the environment variable, then --token, then the config file', () => {
    writeConfig({ token: 'config-token' })
    const env = { [TOKEN_ENV_VAR]: 'env-token' }
    const file = tokenFile('file-token')
    expect(loadConfig({ config: cfgPath, 'token-file': file, token: 'flag-token' }, env).token).toBe('file-token')
    expect(loadConfig({ config: cfgPath, token: 'flag-token' }, env).token).toBe('env-token')
    expect(loadConfig({ config: cfgPath, token: 'flag-token' }, {}).token).toBe('flag-token')
    expect(loadConfig({ config: cfgPath }, {}).token).toBe('config-token')
  })

  it('exits 1 naming the three inputs when no token is given anywhere', () => {
    writeConfig()
    expect(() => loadConfig({ config: cfgPath }, {})).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/--token-file.*CLAWD_AGENT_TOKEN.*config/)
  })

  it('exits 1 for an empty token file without trying the other sources', () => {
    writeConfig({ token: 'config-token' })
    expect(() => loadConfig({ config: cfgPath, 'token-file': tokenFile('\n') }, { [TOKEN_ENV_VAR]: 'env-token' })).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/is empty/)
  })

  it.skipIf(process.platform === 'win32')('exits 1 for a world-readable token file', () => {
    writeConfig()
    expect(() => loadConfig({ config: cfgPath, 'token-file': tokenFile('file-token', 0o644) }, {})).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/accessible to other users/)
    expect(errors.join('\n')).not.toContain('file-token')
  })

  it('removes the variable from the process environment once read, so child processes do not inherit it', () => {
    writeConfig()
    process.env[TOKEN_ENV_VAR] = 'env-token'
    expect(loadConfig({ config: cfgPath }).token).toBe('env-token')
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined()
  })

  it('leaves an injected environment object alone', () => {
    writeConfig()
    const env = { [TOKEN_ENV_VAR]: 'env-token' }
    loadConfig({ config: cfgPath }, env)
    expect(env[TOKEN_ENV_VAR]).toBe('env-token')
  })
})
