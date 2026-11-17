import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveToken, TokenInputError, TOKEN_ENV_VAR } from '../token.js'

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
