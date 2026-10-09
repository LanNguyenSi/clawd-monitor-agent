import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOpenclaw, parseCliJson } from '../collectors/cli.js'

// Exercise the real execFile path against a fake `openclaw` executable on PATH.
describe('runOpenclaw', () => {
  let dir: string
  let oldPath: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-openclaw-'))
    const bin = join(dir, 'openclaw')
    writeFileSync(
      bin,
      '#!/bin/sh\n' +
        'case "$1" in\n' +
        '  ok) echo "args:$*";;\n' +
        '  fail) echo boom >&2; exit 3;;\n' +
        '  slow) sleep 5;;\n' +
        'esac\n',
    )
    chmodSync(bin, 0o755)
    oldPath = process.env.PATH
    process.env.PATH = dir + ':' + oldPath
  })
  afterAll(() => {
    process.env.PATH = oldPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves with stdout and forwards arguments (default timeout)', async () => {
    await expect(runOpenclaw(['ok', 'a', '--json'])).resolves.toBe('args:ok a --json\n')
  })

  it('rejects on a non-zero exit', async () => {
    await expect(runOpenclaw(['fail'])).rejects.toThrow()
  })

  it('rejects when the timeout is exceeded', async () => {
    await expect(runOpenclaw(['slow'], 200)).rejects.toThrow()
  })
})

describe('parseCliJson', () => {
  it('parses plain JSON', () => {
    expect(parseCliJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })
  it('skips leading log lines, including ones that start with "["', () => {
    expect(parseCliJson<{ a: number }>('[plugins] ready\nwarn: x\n{"a":2}')).toEqual({ a: 2 })
  })
  it('parses a top-level array after log noise', () => {
    expect(parseCliJson<number[]>('noise\n[1,2]')).toEqual([1, 2])
  })
  it('throws when nothing parses', () => {
    expect(() => parseCliJson('[plugins] only logs')).toThrow('no JSON')
  })
})
