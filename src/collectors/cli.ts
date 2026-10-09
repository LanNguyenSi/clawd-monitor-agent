import { execFile } from 'node:child_process'

/**
 * Run the `openclaw` CLI and return stdout. The CLI cold-starts a Node
 * process (multiple seconds on a loaded host), so the default timeout is
 * generous and execution is async so the snapshot loop is never blocked.
 */
export function runOpenclaw(args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      args,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

/**
 * Parse CLI JSON output. Newer OpenClaw releases may print plugin/log lines
 * before the JSON document, so fall back to the first line that opens one.
 */
export function parseCliJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T
  } catch {
    const re = /^[\[{]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(stdout)) !== null) {
      try {
        return JSON.parse(stdout.slice(m.index)) as T
      } catch { /* a log line like "[plugins] ..." — keep scanning */ }
    }
    throw new Error('no JSON in CLI output')
  }
}
