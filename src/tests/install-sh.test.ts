import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We exercise install.sh through real bash, but replace every
// privileged side effect (apt, npm, systemctl, useradd, journalctl)
// with stub binaries on PATH that just log their argv to a file. The
// install.sh test hooks (CLAWD_INSTALL_SKIP_ROOT_CHECK,
// CLAWD_INSTALL_SKIP_USER_CREATE, CLAWD_INSTALL_PATH_PREFIX, …) keep
// every filesystem write under a tmp dir.

const REPO_ROOT = join(__dirname, '..', '..')
const INSTALL_SH = join(REPO_ROOT, 'install.sh')

interface Sandbox {
  dir: string
  stubsDir: string
  stubLog: string
  configDir: string
  configFile: string
  serviceFile: string
  serviceHome: string
  systemdProbe: string
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'clawd-install-'))
  const stubsDir = join(dir, 'stubs')
  const configDir = join(dir, 'etc', 'clawd-monitor-agent')
  const serviceHome = join(dir, 'var', 'lib', 'clawd-agent')
  const serviceFile = join(dir, 'etc', 'systemd', 'system', 'clawd-monitor-agent.service')
  const systemdProbe = join(dir, 'run', 'systemd', 'system')

  mkdirSync(stubsDir, { recursive: true })
  mkdirSync(systemdProbe, { recursive: true })
  // Pre-create the parents the script will write into so `mktemp` /
  // `cat >` don't trip on missing dirs. The install.sh path-creation
  // logic (`install -d`) covers most of these, but we want a clean
  // surface to assert against either way.
  mkdirSync(join(dir, 'etc', 'systemd', 'system'), { recursive: true })

  return {
    dir,
    stubsDir,
    stubLog: join(dir, 'stub.log'),
    configDir,
    configFile: join(configDir, 'config.json'),
    serviceFile,
    serviceHome,
    systemdProbe,
  }
}

/**
 * Write a stub binary that logs its argv (one record per line) to
 * STUB_LOG and prints `stdout`. If `extraScript` is given, it runs
 * after the log line — useful for stubs that need to fake behavior
 * (e.g. `node --version`, `systemctl is-active`).
 */
function writeStub(
  sandbox: Sandbox,
  name: string,
  opts: { stdout?: string; exitCode?: number; extraScript?: string } = {},
): void {
  const path = join(sandbox.stubsDir, name)
  const exit = opts.exitCode ?? 0
  const stdout = opts.stdout ?? ''
  const extra = opts.extraScript ?? ''
  const body = [
    '#!/usr/bin/env bash',
    `printf '%s\\t%s\\n' "${name}" "$*" >> "$STUB_LOG"`,
    extra,
    stdout ? `printf '%s' ${JSON.stringify(stdout)}` : '',
    `exit ${exit}`,
  ].join('\n')
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

function defaultStubs(sandbox: Sandbox): void {
  // Fresh-node baseline: pretend node 20 is already installed so the
  // installer skips the NodeSource path. The script calls both
  // `node --version` (string "v20.10.0") AND `node -p ...` (numeric
  // major "20"), so the stub must distinguish them.
  writeStub(sandbox, 'node', {
    extraScript: `
case "$1" in
  --version) echo v20.10.0; exit 0 ;;
  -p)        echo 20;        exit 0 ;;
esac
exit 0
`,
  })
  writeStub(sandbox, 'npm')
  writeStub(sandbox, 'systemctl', {
    extraScript: `
case "$1" in
  is-active)
    # Simulate the unit reaching active immediately so the verify loop
    # doesn't sleep through the whole timeout.
    exit 0
    ;;
esac
`,
  })
  writeStub(sandbox, 'journalctl', { stdout: 'Apr 26 12:00:00 host clawd[1]: [agent] auth ok\n' })
  writeStub(sandbox, 'apt-get')
  writeStub(sandbox, 'curl')
  writeStub(sandbox, 'useradd')
  writeStub(sandbox, 'usermod')
  writeStub(sandbox, 'getent', { exitCode: 1 }) // pretend no `docker` group
  writeStub(sandbox, 'id', {
    extraScript: `
if [ "$1" = "-u" ]; then echo 0; exit 0; fi
if [ "$1" = "-nG" ]; then echo ""; exit 0; fi
exit 0
`,
  })
  writeStub(sandbox, 'install', {
    extraScript: `
# Defer to the real /usr/bin/install for actual mkdir behavior; we
# only need the log line for assertion. -o/-g chown args are dropped
# because the test runs unprivileged.
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"
`,
  })
  // The install.sh resolves \`command -v clawd-monitor-agent\` after npm
  // returns; we provide a dummy on PATH so that succeeds.
  writeStub(sandbox, 'clawd-monitor-agent')
}

function runInstall(
  sandbox: Sandbox,
  args: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    PATH: `${sandbox.stubsDir}:/usr/bin:/bin`,
    HOME: sandbox.dir,
    STUB_LOG: sandbox.stubLog,
    CLAWD_INSTALL_SKIP_ROOT_CHECK: '1',
    CLAWD_INSTALL_SKIP_USER_CREATE: '1',
    CLAWD_INSTALL_CONFIG_DIR: sandbox.configDir,
    CLAWD_INSTALL_SERVICE_FILE: sandbox.serviceFile,
    CLAWD_INSTALL_SERVICE_HOME: sandbox.serviceHome,
    CLAWD_INSTALL_SYSTEMD_PROBE: sandbox.systemdProbe,
    CLAWD_INSTALL_VERIFY_TIMEOUT: '2',
    ...envOverrides,
  }

  const result = spawnSync('bash', [INSTALL_SH, ...args], {
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function readStubLog(sandbox: Sandbox): string[] {
  if (!existsSync(sandbox.stubLog)) return []
  return readFileSync(sandbox.stubLog, 'utf-8').trim().split('\n').filter(Boolean)
}

describe('install.sh', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = makeSandbox()
    defaultStubs(sandbox)
  })

  afterEach(() => {
    rmSync(sandbox.dir, { recursive: true, force: true })
  })

  describe('arg parsing', () => {
    it('exits non-zero with an error when --server is missing', () => {
      const r = runInstall(sandbox, ['--token', 'abc'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--server is required')
    })

    it('exits non-zero with an error when --token is missing', () => {
      const r = runInstall(sandbox, ['--server', 'wss://example'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--token is required')
    })

    it('rejects unknown flags with a clear message', () => {
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 't', '--bogus', 'v'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('unknown argument')
    })

    it('--help prints usage and exits 0', () => {
      // --help short-circuits before the strict --server/--token check.
      const r = spawnSync('bash', [INSTALL_SH, '--help'], { encoding: 'utf-8' })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Usage: install.sh')
    })
  })

  describe('happy path', () => {
    it('writes config + unit file and starts the service', () => {
      const r = runInstall(sandbox, [
        '--server', 'wss://clawd-monitor.example',
        '--token', 'super-secret-token',
        '--name', 'my-vps-01',
      ])
      expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0)

      // Config file written with token.
      expect(existsSync(sandbox.configFile)).toBe(true)
      const cfg = JSON.parse(readFileSync(sandbox.configFile, 'utf-8'))
      expect(cfg.server).toBe('wss://clawd-monitor.example')
      expect(cfg.token).toBe('super-secret-token')
      expect(cfg.name).toBe('my-vps-01')
      expect(cfg.gateway.url).toBe('http://localhost:18789')

      // Unit file written.
      expect(existsSync(sandbox.serviceFile)).toBe(true)
      const unit = readFileSync(sandbox.serviceFile, 'utf-8')
      expect(unit).toContain('User=clawd-agent')
      expect(unit).toContain(`ExecStart=${sandbox.stubsDir}/clawd-monitor-agent --config ${sandbox.configFile}`)
      expect(unit).toContain('Restart=always')
      // Hardening flags must be present.
      expect(unit).toContain('NoNewPrivileges=true')
      expect(unit).toContain('ProtectSystem=strict')

      // Service was activated.
      const log = readStubLog(sandbox)
      expect(log).toContain('systemctl\tdaemon-reload')
      expect(log).toContain('systemctl\tenable clawd-monitor-agent')
      expect(log).toContain('systemctl\trestart clawd-monitor-agent')
    })

    it('the unit file does NOT embed the token', () => {
      runInstall(sandbox, [
        '--server', 'wss://x',
        '--token', 'NEVER_IN_UNIT_FILE_xyz',
      ])
      const unit = readFileSync(sandbox.serviceFile, 'utf-8')
      expect(unit).not.toContain('NEVER_IN_UNIT_FILE_xyz')
    })

    it('does not echo the token to stdout or stderr', () => {
      const r = runInstall(sandbox, [
        '--server', 'wss://x',
        '--token', 'SECRET_TOKEN_xyz_must_not_leak',
      ])
      expect(r.stdout).not.toContain('SECRET_TOKEN_xyz_must_not_leak')
      expect(r.stderr).not.toContain('SECRET_TOKEN_xyz_must_not_leak')
    })

    it('config file is mode 0640', () => {
      runInstall(sandbox, ['--server', 'wss://x', '--token', 't'])
      const stat = execFileSync('stat', ['-c', '%a', sandbox.configFile], { encoding: 'utf-8' }).trim()
      expect(stat).toBe('640')
    })
  })

  describe('idempotency', () => {
    it('re-running with the same args restarts the service without leaking state', () => {
      const args = ['--server', 'wss://x', '--token', 'first-token']
      const first = runInstall(sandbox, args)
      expect(first.status).toBe(0)
      const second = runInstall(sandbox, args)
      expect(second.status).toBe(0)

      const log = readStubLog(sandbox)
      // restart command should appear twice — once per run.
      const restarts = log.filter((l) => l === 'systemctl\trestart clawd-monitor-agent')
      expect(restarts.length).toBe(2)
    })

    it('re-running with a different --token rotates the token in the config', () => {
      runInstall(sandbox, ['--server', 'wss://x', '--token', 'token-A'])
      let cfg = JSON.parse(readFileSync(sandbox.configFile, 'utf-8'))
      expect(cfg.token).toBe('token-A')

      runInstall(sandbox, ['--server', 'wss://x', '--token', 'token-B'])
      cfg = JSON.parse(readFileSync(sandbox.configFile, 'utf-8'))
      expect(cfg.token).toBe('token-B')
    })
  })

  describe('node detection', () => {
    it('skips NodeSource install when node 18+ is already present', () => {
      runInstall(sandbox, ['--server', 'wss://x', '--token', 't'])
      const log = readStubLog(sandbox)
      expect(log.filter((l) => l.startsWith('curl\t')).length).toBe(0)
      expect(log.filter((l) => l.startsWith('apt-get\t')).length).toBe(0)
    })

    it('runs NodeSource setup + apt-get install when node is missing', () => {
      // Replace the node stub with a non-existent binary by removing it
      // from PATH for *only* this test. Easiest way: make the stub fail
      // the `command -v node` check by... actually `command -v` will
      // still find the stub. We need to remove the file.
      rmSync(join(sandbox.stubsDir, 'node'))

      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 't'])
      // The script attempts to install node via apt-get. With our stubs
      // that succeed but never actually install node, the
      // post-install `command -v node` check would fail.
      // We accept either: success (if PATH has real node from /usr/bin)
      // OR failure mentioning the curl + apt-get path was taken.
      const log = readStubLog(sandbox)
      const apt = log.filter((l) => l.startsWith('apt-get\t'))
      const curl = log.filter((l) => l.startsWith('curl\t'))
      expect(apt.length, `apt-get not invoked. log:\n${log.join('\n')}`).toBeGreaterThan(0)
      expect(curl.length, `curl not invoked. log:\n${log.join('\n')}`).toBeGreaterThan(0)
      // The status doesn't matter here — we're asserting on *behavior*
      // (the script took the install path), not on whether the host
      // had a real node binary to validate against.
      void r
    })
  })

  describe('verify step', () => {
    it('fails loud on the wire-level "auth_error" message type', () => {
      writeStub(sandbox, 'journalctl', {
        stdout: 'Apr 26 12:00:00 host clawd[1]: received auth_error from server\n',
      })
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 'wrong'])
      expect(r.status).not.toBe(0)
      expect(r.stderr.toLowerCase()).toContain('auth')
    })

    it('fails loud on the human "Authentication failed: ..." log line that the agent actually emits', () => {
      // This is the real wording from src/agent.ts:97 — the previous
      // regex (`auth.failed`) DID NOT match this string, so a
      // bad-token install would have silently passed verify.
      writeStub(sandbox, 'journalctl', {
        stdout: 'Apr 26 12:00:00 host clawd[1]: [clawd-agent][ERROR] Authentication failed: invalid token\n',
      })
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 'wrong'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('auth error detected')
    })

    it('does not false-match unrelated log noise containing "forbidden" or "401"', () => {
      // We deliberately removed those patterns from the regex; lock
      // that decision in with a regression test so a future tightening
      // doesn't accidentally re-introduce them.
      writeStub(sandbox, 'journalctl', {
        stdout: 'Apr 26 12:00:00 host kernel: audit: forbidden syscall (unrelated)\nApr 26 12:00:01 host x: GET /foo 401\n',
      })
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 't'])
      expect(r.status, `should not fail on unrelated 'forbidden'/'401' noise. stderr: ${r.stderr}`).toBe(0)
    })

    it('fails when the unit never reaches active', () => {
      writeStub(sandbox, 'systemctl', {
        extraScript: `
case "$1" in
  is-active) exit 3 ;;
esac
exit 0
`,
      })
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 't'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain("failed to start")
    })
  })

  describe('preflight', () => {
    it('refuses when systemd is not detected', () => {
      // Point the systemd-probe path at a directory that doesn't exist.
      const r = runInstall(sandbox, ['--server', 'wss://x', '--token', 't'], {
        CLAWD_INSTALL_SYSTEMD_PROBE: join(sandbox.dir, 'no-such-dir'),
      })
      expect(r.status).not.toBe(0)
      expect(r.stderr.toLowerCase()).toContain('systemd not detected')
    })
  })
})
