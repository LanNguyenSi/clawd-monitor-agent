import { closeSync, fstatSync, openSync, readFileSync } from 'fs'

/** Environment variable that can carry the agent token (never shown in `ps`). */
export const TOKEN_ENV_VAR = 'CLAWD_AGENT_TOKEN'

export interface TokenInputs {
  /** Value of `--token-file`, a path. */
  tokenFile?: string
  /** Value of the deprecated `--token` flag. */
  tokenFlag?: string
  /** `token` key of the `--config` file. */
  configToken?: string
  /** Process environment; injectable for tests. */
  env?: NodeJS.ProcessEnv
}

/** A fatal input error; the caller prints `message` and exits 1. */
export class TokenInputError extends Error {}

/**
 * Reads the token from a file. The mode is checked on the open descriptor, so
 * the file cannot be swapped between the check and the read. A file that
 * other users can access at all is refused (the token would be exposed to
 * them); one that only a group can access is accepted with a warning. An
 * empty file is an error, never a fall-through to another source: the path
 * was given on purpose.
 */
function readTokenFile(path: string, warn: (msg: string) => void): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (err) {
    throw new TokenInputError(`Cannot read token file ${JSON.stringify(path)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      throw new TokenInputError(`Token file ${JSON.stringify(path)} is not a regular file`)
    }
    if (process.platform !== 'win32') {
      const mode = st.mode & 0o777
      if (mode & 0o007) {
        throw new TokenInputError(
          `Token file ${JSON.stringify(path)} is accessible to other users (mode ${mode.toString(8).padStart(3, '0')}); run: chmod 600 ${path}`,
        )
      }
      if (mode & 0o070) {
        warn(`token file ${JSON.stringify(path)} is accessible to its group (mode ${mode.toString(8).padStart(3, '0')}); mode 600 is recommended`)
      }
    }
    const token = readFileSync(fd, 'utf-8').trim()
    if (token === '') {
      throw new TokenInputError(`Token file ${JSON.stringify(path)} is empty`)
    }
    return token
  } finally {
    closeSync(fd)
  }
}

/**
 * Picks the agent token. Precedence, highest first:
 *
 *   1. `--token-file <path>`
 *   2. `CLAWD_AGENT_TOKEN` environment variable
 *   3. `--token <value>` (deprecated: the value is visible in the process list)
 *   4. `token` in the `--config` file
 *
 * A source that is set to an empty (or whitespace-only) value is ignored and
 * the next one is tried, except for `--token-file`, where an empty path or an
 * empty file is an error. Returns undefined when no source has a token.
 */
export function resolveToken(
  inputs: TokenInputs,
  warn: (msg: string) => void = (m) => console.error(`[clawd-agent][WARN] ${m}`),
): string | undefined {
  const env = inputs.env ?? process.env

  if (inputs.tokenFlag !== undefined && inputs.tokenFlag !== '') {
    warn(`--token is deprecated: the value is visible in the process list (ps, /proc/<pid>/cmdline). Use --token-file <path> or the ${TOKEN_ENV_VAR} environment variable instead.`)
  }

  if (inputs.tokenFile !== undefined) return readTokenFile(inputs.tokenFile, warn)

  const fromEnv = env[TOKEN_ENV_VAR]?.trim()
  if (fromEnv) return fromEnv

  if (inputs.tokenFlag !== undefined && inputs.tokenFlag !== '') return inputs.tokenFlag

  if (inputs.configToken !== undefined && inputs.configToken !== '') return inputs.configToken
  return undefined
}
