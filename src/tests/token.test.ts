import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveGatewayToken, resolveToken, TokenInputError, TOKEN_ENV_VAR, GATEWAY_TOKEN_ENV_VAR } from '../token.js'

// Real files and real modes: the mode check is the point of the feature, so
// nothing here is mocked.

let dir: string
let warnings: string[]
const warn = (m: string) => { warnings.push(m) }

function tokenFile(content: string, mode = 0o600, name = 'token'): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clawd-token-'))
  warnings = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveToken precedence', () => {
  // Each source alone.
  it('uses --token-file alone', () => {
    expect(resolveToken({ tokenFile: tokenFile('from-file\n'), env: {} }, warn)).toBe('from-file')
  })
  it('uses the environment variable alone', () => {
    expect(resolveToken({ env: { [TOKEN_ENV_VAR]: 'from-env' } }, warn)).toBe('from-env')
  })
  it('uses --token alone', () => {
    expect(resolveToken({ tokenFlag: 'from-flag', env: {} }, warn)).toBe('from-flag')
  })
  it('uses the config file token alone', () => {
    expect(resolveToken({ configToken: 'from-config', env: {} }, warn)).toBe('from-config')
  })
  it('returns undefined when nothing is set', () => {
    expect(resolveToken({ env: {} }, warn)).toBeUndefined()
  })

  // Pairs: the higher one wins.
  it('--token-file beats the environment variable', () => {
    expect(resolveToken({ tokenFile: tokenFile('file'), env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toBe('file')
  })
  it('--token-file beats --token', () => {
    expect(resolveToken({ tokenFile: tokenFile('file'), tokenFlag: 'flag', env: {} }, warn)).toBe('file')
  })
  it('--token-file beats the config file token', () => {
    expect(resolveToken({ tokenFile: tokenFile('file'), configToken: 'config', env: {} }, warn)).toBe('file')
  })
  it('the environment variable beats --token', () => {
    expect(resolveToken({ tokenFlag: 'flag', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toBe('env')
  })
  it('the environment variable beats the config file token', () => {
    expect(resolveToken({ configToken: 'config', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toBe('env')
  })
  it('--token beats the config file token', () => {
    expect(resolveToken({ tokenFlag: 'flag', configToken: 'config', env: {} }, warn)).toBe('flag')
  })
  it('all four set: --token-file wins', () => {
    expect(
      resolveToken({ tokenFile: tokenFile('file'), tokenFlag: 'flag', configToken: 'config', env: { [TOKEN_ENV_VAR]: 'env' } }, warn),
    ).toBe('file')
  })

  // Empty versus absent.
  it('an empty environment variable is ignored and the next source is used', () => {
    expect(resolveToken({ tokenFlag: 'flag', env: { [TOKEN_ENV_VAR]: '' } }, warn)).toBe('flag')
    expect(resolveToken({ configToken: 'config', env: { [TOKEN_ENV_VAR]: '  \n' } }, warn)).toBe('config')
  })
  it('an empty --token is ignored and the config file token is used', () => {
    expect(resolveToken({ tokenFlag: '', configToken: 'config', env: {} }, warn)).toBe('config')
  })
  it('an empty config file token counts as absent', () => {
    expect(resolveToken({ configToken: '', env: {} }, warn)).toBeUndefined()
  })
  it('an empty --token-file is an error, not a fall-through to the next source', () => {
    const p = tokenFile(' \n')
    expect(() => resolveToken({ tokenFile: p, tokenFlag: 'flag', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toThrow(/is empty/)
  })
  it('an empty --token-file path is an error', () => {
    expect(() => resolveToken({ tokenFile: '', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toThrow(TokenInputError)
  })
  it('the environment variable value is trimmed', () => {
    expect(resolveToken({ env: { [TOKEN_ENV_VAR]: ' abc \n' } }, warn)).toBe('abc')
  })
})

describe('resolveToken token file', () => {
  it('trims the trailing newline', () => {
    expect(resolveToken({ tokenFile: tokenFile('abc123\n'), env: {} }, warn)).toBe('abc123')
    expect(warnings).toEqual([])
  })
  it('reports a missing file as an error that names the path and not the token', () => {
    expect(() => resolveToken({ tokenFile: join(dir, 'nope'), tokenFlag: 'flag', env: {} }, warn)).toThrow(/Cannot read token file .*nope.*ENOENT/)
  })
  it('refuses a directory', () => {
    const d = join(dir, 'a-dir')
    mkdirSync(d)
    expect(() => resolveToken({ tokenFile: d, env: {} }, warn)).toThrow(/not a regular file/)
  })
  it('follows a symlink and checks the mode of its target', () => {
    const target = tokenFile('linked', 0o644, 'target')
    const link = join(dir, 'link')
    symlinkSync(target, link)
    expect(() => resolveToken({ tokenFile: link, env: {} }, warn)).toThrow(/accessible to other users/)
  })

  describe.skipIf(process.platform === 'win32')('file mode', () => {
    it('accepts mode 600 and 400 without a warning', () => {
      expect(resolveToken({ tokenFile: tokenFile('t', 0o600), env: {} }, warn)).toBe('t')
      expect(resolveToken({ tokenFile: tokenFile('t', 0o400, 'ro'), env: {} }, warn)).toBe('t')
      expect(warnings).toEqual([])
    })
    it.each([0o644, 0o604, 0o602, 0o666, 0o640 | 0o001])('refuses mode %o (other users have access)', (mode) => {
      const p = tokenFile('secret-value', mode)
      let message = ''
      try {
        resolveToken({ tokenFile: p, env: {} }, warn)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/accessible to other users/)
      expect(message).toContain('chmod 600')
      expect(message).not.toContain('secret-value')
    })
    it.each([0o640, 0o660, 0o440])('accepts mode %o with a group warning', (mode) => {
      expect(resolveToken({ tokenFile: tokenFile('t', mode), env: {} }, warn)).toBe('t')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/accessible to its group/)
    })
    it('a refused file does not fall through to another source', () => {
      const p = tokenFile('t', 0o644)
      expect(() => resolveToken({ tokenFile: p, tokenFlag: 'flag', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)).toThrow(TokenInputError)
    })
  })
})

describe('resolveToken --token deprecation warning', () => {
  it('warns when --token is used alone', () => {
    resolveToken({ tokenFlag: 'secret-flag-value', env: {} }, warn)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/--token is deprecated/)
    expect(warnings[0]).toContain('--token-file')
    expect(warnings[0]).toContain(TOKEN_ENV_VAR)
    expect(warnings[0]).not.toContain('secret-flag-value')
  })
  it('warns even when a higher source wins, because the argv is exposed anyway', () => {
    resolveToken({ tokenFile: tokenFile('f'), tokenFlag: 'flag', env: {} }, warn)
    resolveToken({ tokenFlag: 'flag', env: { [TOKEN_ENV_VAR]: 'env' } }, warn)
    expect(warnings).toHaveLength(2)
  })
  it('does not warn without --token or for an empty --token', () => {
    resolveToken({ env: { [TOKEN_ENV_VAR]: 'env' } }, warn)
    resolveToken({ tokenFile: tokenFile('f'), env: {} }, warn)
    resolveToken({ configToken: 'c', env: {} }, warn)
    resolveToken({ tokenFlag: '', configToken: 'c', env: {} }, warn)
    expect(warnings).toEqual([])
  })
  it('writes the warning to stderr by default, never to stdout', () => {
    const errs: string[] = []
    const outs: string[] = []
    const origErr = console.error
    const origLog = console.log
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')) }
    console.log = (...a: unknown[]) => { outs.push(a.join(' ')) }
    try {
      resolveToken({ tokenFlag: 'flag', env: {} })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    expect(errs.join('\n')).toMatch(/\[WARN\] --token is deprecated/)
    expect(outs).toEqual([])
  })
})

describe('token file that is a FIFO', () => {
  // A FIFO opened for reading blocks until a writer appears; the check must
  // refuse it instead of hanging the start-up. Run in a child process so a
  // regression is a timeout here and not a hung test runner.
  it.skipIf(process.platform === 'win32')('is refused with "not a regular file" and does not block', () => {
    const fifo = join(dir, 'fifo')
    const mk = spawnSync('mkfifo', [fifo])
    expect(mk.status).toBe(0)
    // Compile token.ts into the temp dir so the test does not depend on dist/.
    const outDir = join(dir, 'compiled')
    const tsc = spawnSync(
      process.execPath,
      [join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), join(__dirname, '..', 'token.ts'),
        '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--types', 'node'],
      { encoding: 'utf-8', timeout: 60_000 },
    )
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0)
    const script = `
      const { resolveToken, resolveGatewayToken } = require(${JSON.stringify(join(outDir, 'token.js'))})
      const out = []
      for (const fn of [() => resolveToken({ tokenFile: ${JSON.stringify(fifo)}, env: {} }), () => resolveGatewayToken({ tokenFile: ${JSON.stringify(fifo)}, env: {} })]) {
        try { fn(); out.push('no error') } catch (e) { out.push(e.message) }
      }
      console.log(JSON.stringify(out))
    `
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 5000 })
    expect(r.error).toBeUndefined()
    const messages = JSON.parse(r.stdout) as string[]
    expect(messages[0]).toMatch(/Token file .*fifo.* is not a regular file/)
    expect(messages[1]).toMatch(/Gateway token file .*fifo.* is not a regular file/)
  }, 90_000)
})

describe('resolveGatewayToken precedence', () => {
  const ENV = GATEWAY_TOKEN_ENV_VAR
  const gw = (inputs: Parameters<typeof resolveGatewayToken>[0]) => resolveGatewayToken(inputs, warn)

  // Each source alone: which value the collectors use and which is forwarded.
  it('--gateway-token-file alone: used and forwarded', () => {
    expect(gw({ tokenFile: tokenFile('from-file\n'), env: {} })).toEqual({ token: 'from-file', forwarded: 'from-file' })
  })
  it('the environment variable alone: used, never forwarded', () => {
    expect(gw({ env: { [ENV]: 'from-env' } })).toEqual({ token: 'from-env', forwarded: undefined })
  })
  it('--gateway-token alone: used and forwarded', () => {
    expect(gw({ tokenFlag: 'from-flag', env: {} })).toEqual({ token: 'from-flag', forwarded: 'from-flag' })
  })
  it('the config file token alone: used and forwarded', () => {
    expect(gw({ configToken: 'from-config', env: {} })).toEqual({ token: 'from-config', forwarded: 'from-config' })
  })
  it('nothing set: no token at all', () => {
    expect(gw({ env: {} })).toEqual({ token: undefined, forwarded: undefined })
  })

  // Pairs: the higher one is used.
  it('file beats the environment variable (used), and is the one forwarded', () => {
    expect(gw({ tokenFile: tokenFile('file'), env: { [ENV]: 'env' } })).toEqual({ token: 'file', forwarded: 'file' })
  })
  it('file beats --gateway-token', () => {
    expect(gw({ tokenFile: tokenFile('file'), tokenFlag: 'flag', env: {} })).toEqual({ token: 'file', forwarded: 'file' })
  })
  it('file beats the config file token', () => {
    expect(gw({ tokenFile: tokenFile('file'), configToken: 'config', env: {} })).toEqual({ token: 'file', forwarded: 'file' })
  })
  it('the environment variable beats --gateway-token for use; the flag is what is forwarded', () => {
    expect(gw({ tokenFlag: 'flag', env: { [ENV]: 'env' } })).toEqual({ token: 'env', forwarded: 'flag' })
  })
  it('the environment variable beats the config file token for use; the config token is what is forwarded', () => {
    expect(gw({ configToken: 'config', env: { [ENV]: 'env' } })).toEqual({ token: 'env', forwarded: 'config' })
  })
  it('--gateway-token beats the config file token, also when forwarded', () => {
    expect(gw({ tokenFlag: 'flag', configToken: 'config', env: {} })).toEqual({ token: 'flag', forwarded: 'flag' })
  })
  it('all four set: the file wins for use and forwarding', () => {
    expect(
      gw({ tokenFile: tokenFile('file'), tokenFlag: 'flag', configToken: 'config', env: { [ENV]: 'env' } }),
    ).toEqual({ token: 'file', forwarded: 'file' })
  })
  it('flag, config and environment set (no file): the environment is used, the flag is forwarded', () => {
    expect(gw({ tokenFlag: 'flag', configToken: 'config', env: { [ENV]: 'env' } })).toEqual({ token: 'env', forwarded: 'flag' })
  })

  // Empty versus absent.
  it('an empty or blank environment variable is ignored', () => {
    expect(gw({ tokenFlag: 'flag', env: { [ENV]: '' } }).token).toBe('flag')
    expect(gw({ configToken: 'config', env: { [ENV]: '  \n' } }).token).toBe('config')
    expect(gw({ env: { [ENV]: ' ' } })).toEqual({ token: undefined, forwarded: undefined })
  })
  it('an empty --gateway-token is ignored (it no longer shadows the environment variable) and does not warn', () => {
    expect(gw({ tokenFlag: '', env: { [ENV]: 'env' } })).toEqual({ token: 'env', forwarded: undefined })
    expect(gw({ tokenFlag: '', configToken: 'config', env: {} })).toEqual({ token: 'config', forwarded: 'config' })
    expect(warnings).toEqual([])
  })
  it('an empty config file token counts as absent', () => {
    expect(gw({ configToken: '', env: { [ENV]: 'env' } })).toEqual({ token: 'env', forwarded: undefined })
    expect(gw({ configToken: '', env: {} })).toEqual({ token: undefined, forwarded: undefined })
  })
  it('an empty gateway token file is an error, not a fall-through', () => {
    const p = tokenFile(' \n')
    expect(() => gw({ tokenFile: p, tokenFlag: 'flag', env: { [ENV]: 'env' } })).toThrow(/Gateway token file .* is empty/)
  })
  it('an empty --gateway-token-file path is an error', () => {
    expect(() => gw({ tokenFile: '', env: { [ENV]: 'env' } })).toThrow(TokenInputError)
  })
  it('a missing gateway token file is an error that names the path and not a token', () => {
    expect(() => gw({ tokenFile: join(dir, 'nope'), tokenFlag: 'flag-secret', env: {} })).toThrow(/Cannot read gateway token file .*nope.*ENOENT/)
  })
  it('the environment variable value is trimmed', () => {
    expect(gw({ env: { [ENV]: ' abc \n' } }).token).toBe('abc')
  })
  it('the agent token variable is not a gateway token source, and the reverse', () => {
    expect(gw({ env: { [TOKEN_ENV_VAR]: 'agent' } }).token).toBeUndefined()
    expect(resolveToken({ env: { [ENV]: 'gateway' } }, warn)).toBeUndefined()
  })
})

describe('resolveGatewayToken file policy (same as the agent token file)', () => {
  it('trims the trailing newline and does not warn for mode 600', () => {
    expect(resolveGatewayToken({ tokenFile: tokenFile('abc123\n'), env: {} }, warn).token).toBe('abc123')
    expect(warnings).toEqual([])
  })
  it('refuses a directory', () => {
    const d = join(dir, 'a-dir')
    mkdirSync(d)
    expect(() => resolveGatewayToken({ tokenFile: d, env: {} }, warn)).toThrow(/Gateway token file .* is not a regular file/)
  })
  describe.skipIf(process.platform === 'win32')('file mode', () => {
    it.each([0o644, 0o604, 0o602, 0o666])('refuses mode %o with a chmod hint and without the token', (mode) => {
      const p = tokenFile('secret-value', mode)
      let message = ''
      try {
        resolveGatewayToken({ tokenFile: p, env: {} }, warn)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/Gateway token file .* is accessible to other users/)
      expect(message).toContain('chmod 600')
      expect(message).not.toContain('secret-value')
    })
    it.each([0o640, 0o660, 0o440])('accepts mode %o with a group warning', (mode) => {
      expect(resolveGatewayToken({ tokenFile: tokenFile('t', mode), env: {} }, warn).token).toBe('t')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/gateway token file .* is accessible to its group/)
    })
    it('a refused file does not fall through to another source', () => {
      const p = tokenFile('t', 0o644)
      expect(() => resolveGatewayToken({ tokenFile: p, tokenFlag: 'flag', env: { [GATEWAY_TOKEN_ENV_VAR]: 'env' } }, warn)).toThrow(TokenInputError)
    })
  })
})

describe('resolveGatewayToken --gateway-token deprecation warning', () => {
  it('warns when --gateway-token is used alone, naming the replacements and not the value', () => {
    resolveGatewayToken({ tokenFlag: 'secret-flag-value', env: {} }, warn)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/--gateway-token is deprecated/)
    expect(warnings[0]).toContain('--gateway-token-file')
    expect(warnings[0]).toContain(GATEWAY_TOKEN_ENV_VAR)
    expect(warnings[0]).not.toContain('secret-flag-value')
  })
  it('warns even when a higher source wins', () => {
    resolveGatewayToken({ tokenFile: tokenFile('f'), tokenFlag: 'flag', env: {} }, warn)
    resolveGatewayToken({ tokenFlag: 'flag', env: { [GATEWAY_TOKEN_ENV_VAR]: 'env' } }, warn)
    expect(warnings).toHaveLength(2)
  })
  it('does not warn for the other sources', () => {
    resolveGatewayToken({ env: { [GATEWAY_TOKEN_ENV_VAR]: 'env' } }, warn)
    resolveGatewayToken({ tokenFile: tokenFile('f'), env: {} }, warn)
    resolveGatewayToken({ configToken: 'c', env: {} }, warn)
    expect(warnings).toEqual([])
  })
  it('writes the warning to stderr by default, never to stdout', () => {
    const errs: string[] = []
    const outs: string[] = []
    const origErr = console.error
    const origLog = console.log
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')) }
    console.log = (...a: unknown[]) => { outs.push(a.join(' ')) }
    try {
      resolveGatewayToken({ tokenFlag: 'flag', env: {} })
    } finally {
      console.error = origErr
      console.log = origLog
    }
    expect(errs.join('\n')).toMatch(/\[WARN\] --gateway-token is deprecated/)
    expect(outs).toEqual([])
  })
})
