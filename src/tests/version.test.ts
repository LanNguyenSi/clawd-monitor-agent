import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../version.js'

const SRC_DIR = join(__dirname, '..')

describe('VERSION', () => {
  it('matches package.json (single source of truth)', () => {
    const pkgPath = join(__dirname, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('looks like a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  // DRY-invariant guard: lock in that no source file outside version.ts
  // ever re-introduces a hardcoded version string. The earlier shape of
  // this codebase had `const VERSION = '1.0.0'` hardcoded in TWO places
  // (src/cli.ts and src/collectors/index.ts) that drifted unnoticed
  // through 15+ commits. This test catches a regression by name —
  // `VERSION =` paired with a quoted semver literal — wherever it
  // appears under src/ except the one place it's allowed.
  it.each([
    ['cli.ts',                 join(SRC_DIR, 'cli.ts')],
    ['collectors/index.ts',    join(SRC_DIR, 'collectors', 'index.ts')],
  ])('does not re-introduce a hardcoded VERSION literal in %s', (_label, path) => {
    const source = readFileSync(path, 'utf-8')
    // Match `VERSION = '1.2.3'` or `VERSION = "1.2.3"` only — does
    // not flag the legitimate `import { VERSION } from './version.js'`.
    expect(source).not.toMatch(/VERSION\s*=\s*['"]\d+\.\d+\.\d+/)
  })
})
