import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../config.js'
import { TOKEN_ENV_VAR, GATEWAY_TOKEN_ENV_VAR } from '../token.js'

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
  delete process.env[GATEWAY_TOKEN_ENV_VAR]
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

  it('removes the variable from the process environment when --token-file wins over it', () => {
    writeConfig()
    process.env[TOKEN_ENV_VAR] = 'env-token'
    expect(loadConfig({ config: cfgPath, 'token-file': tokenFile('file-token') }).token).toBe('file-token')
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined()
  })

  it('removes a blank variable from the process environment when --token wins', () => {
    // The variable never wins against --token unless it is blank; it is still removed.
    writeConfig()
    process.env[TOKEN_ENV_VAR] = '  '
    expect(loadConfig({ config: cfgPath, token: 'flag-token' }).token).toBe('flag-token')
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined()
  })

  it('removes the variable from the process environment when the config file token is used', () => {
    writeConfig({ token: 'config-token' })
    process.env[TOKEN_ENV_VAR] = ''
    expect(loadConfig({ config: cfgPath }).token).toBe('config-token')
    expect(process.env[TOKEN_ENV_VAR]).toBeUndefined()
  })

  it('leaves an injected environment object alone', () => {
    writeConfig()
    const env = { [TOKEN_ENV_VAR]: 'env-token' }
    loadConfig({ config: cfgPath }, env)
    expect(env[TOKEN_ENV_VAR]).toBe('env-token')
  })
})

describe('loadConfig gateway token sources', () => {
  const agentTokenFile = () => {
    const p = join(dir, 'agent-token')
    writeFileSync(p, 'agent\n')
    chmodSync(p, 0o600)
    return p
  }
  const gwFile = (content: string, mode = 0o600) => {
    const p = join(dir, 'gateway-token')
    writeFileSync(p, content)
    chmodSync(p, mode)
    return p
  }
  const gateway = (args: Record<string, string>, env: NodeJS.ProcessEnv = {}) =>
    loadConfig({ config: cfgPath, 'token-file': agentTokenFile(), ...args } as never, env).gateway
  const ENV = GATEWAY_TOKEN_ENV_VAR

  it('reads --gateway-token-file: used by the collectors and forwarded', () => {
    writeConfig()
    expect(gateway({ 'gateway-token-file': gwFile('gw-file\n') })).toMatchObject({ token: 'gw-file', collectorToken: 'gw-file' })
    expect(errors).toEqual([])
  })

  it('reads the environment variable: used by the collectors, not forwarded', () => {
    writeConfig()
    const gw = gateway({}, { [ENV]: 'gw-env' })
    expect(gw.collectorToken).toBe('gw-env')
    expect(gw.token).toBeUndefined()
  })

  it('--gateway-token still works, with a deprecation warning on stderr, and is forwarded', () => {
    writeConfig()
    expect(gateway({ 'gateway-token': 'gw-flag' })).toMatchObject({ token: 'gw-flag', collectorToken: 'gw-flag' })
    expect(errors.join('\n')).toMatch(/--gateway-token is deprecated/)
  })

  it('still reads gateway.token of the config file (what install.sh wrote before): used and forwarded, no warning', () => {
    writeConfig({ gateway: { url: 'http://gw', token: 'gw-config' } })
    expect(gateway({})).toMatchObject({ url: 'http://gw', token: 'gw-config', collectorToken: 'gw-config' })
    expect(errors).toEqual([])
  })

  it('has no gateway token when nothing is set, and that is not an error', () => {
    writeConfig()
    expect(gateway({})).toMatchObject({ token: undefined, collectorToken: undefined })
  })

  it('precedence: file, then the environment variable, then --gateway-token, then the config file', () => {
    writeConfig({ gateway: { token: 'gw-config' } })
    const env = { [ENV]: 'gw-env' }
    const file = gwFile('gw-file')
    expect(gateway({ 'gateway-token-file': file, 'gateway-token': 'gw-flag' }, env)).toMatchObject({ collectorToken: 'gw-file', token: 'gw-file' })
    expect(gateway({ 'gateway-token': 'gw-flag' }, env)).toMatchObject({ collectorToken: 'gw-env', token: 'gw-flag' })
    expect(gateway({}, env)).toMatchObject({ collectorToken: 'gw-env', token: 'gw-config' })
    expect(gateway({ 'gateway-token': 'gw-flag' }, {})).toMatchObject({ collectorToken: 'gw-flag', token: 'gw-flag' })
    expect(gateway({}, {})).toMatchObject({ collectorToken: 'gw-config', token: 'gw-config' })
  })

  it('an empty --gateway-token does not shadow the environment variable or the config file', () => {
    writeConfig({ gateway: { token: 'gw-config' } })
    expect(gateway({ 'gateway-token': '' }, { [ENV]: 'gw-env' }).collectorToken).toBe('gw-env')
    expect(gateway({ 'gateway-token': '' }, {}).collectorToken).toBe('gw-config')
  })

  it('exits 1 for an empty gateway token file without trying the other sources', () => {
    writeConfig({ gateway: { token: 'gw-config' } })
    expect(() => gateway({ 'gateway-token-file': gwFile('\n') }, { [ENV]: 'gw-env' })).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/Gateway token file .* is empty/)
  })

  it('exits 1 for a missing gateway token file', () => {
    writeConfig()
    expect(() => gateway({ 'gateway-token-file': join(dir, 'missing') })).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/Cannot read gateway token file/)
  })

  it.skipIf(process.platform === 'win32')('exits 1 for a world-readable gateway token file, without printing the token', () => {
    writeConfig()
    expect(() => gateway({ 'gateway-token-file': gwFile('gw-secret', 0o644) })).toThrow('exit:1')
    expect(errors.join('\n')).toMatch(/accessible to other users/)
    expect(errors.join('\n')).not.toContain('gw-secret')
  })

  it('a bad gateway token file does not hide behind a valid agent token', () => {
    writeConfig()
    expect(() => loadConfig({ config: cfgPath, 'token-file': agentTokenFile(), 'gateway-token-file': join(dir, 'missing') } as never, {})).toThrow('exit:1')
  })

  it('leaves OPENCLAW_GATEWAY_TOKEN in the process environment: the openclaw CLI the collectors start reads it', () => {
    writeConfig()
    process.env[ENV] = 'gw-env'
    expect(loadConfig({ config: cfgPath, 'token-file': agentTokenFile() } as never).gateway.collectorToken).toBe('gw-env')
    expect(process.env[ENV]).toBe('gw-env')
  })

  it('the agent token and the gateway token do not mix', () => {
    writeConfig()
    const env = { [TOKEN_ENV_VAR]: 'agent-env', [ENV]: 'gw-env' }
    const cfg = loadConfig({ config: cfgPath } as never, env)
    expect(cfg.token).toBe('agent-env')
    expect(cfg.gateway.collectorToken).toBe('gw-env')
  })
})
