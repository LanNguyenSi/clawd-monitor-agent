import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'fs'

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

/**
 * Environment variable that can carry the OpenClaw Gateway token. The
 * `openclaw` CLI the collectors start reads the same variable.
 */
export const GATEWAY_TOKEN_ENV_VAR = 'OPENCLAW_GATEWAY_TOKEN'

export interface GatewayTokenInputs {
  /** Value of `--gateway-token-file`, a path. */
  tokenFile?: string
  /** Value of the deprecated `--gateway-token` flag. */
  tokenFlag?: string
  /** `gateway.token` key of the `--config` file. */
  configToken?: string
  /** Process environment; injectable for tests. */
  env?: NodeJS.ProcessEnv
}

export interface GatewayTokenResolution {
  /** The token the collectors use to call the Gateway. */
  token?: string
  /**
   * The token sent to the dashboard server in the `auth` message: from
   * `--gateway-token-file`, `--gateway-token` or the config file, never from
   * the environment variable (which stays on the agent host).
   */
  forwarded?: string
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
function readTokenFile(path: string, warn: (msg: string) => void, label = 'Token file'): string {
  const lower = label.toLowerCase()
  let fd: number
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer
    // and hang the start-up; the regular-file check below then refuses it.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
  } catch (err) {
    throw new TokenInputError(`Cannot read ${lower} ${JSON.stringify(path)}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      throw new TokenInputError(`${label} ${JSON.stringify(path)} is not a regular file`)
    }
    if (process.platform !== 'win32') {
      const mode = st.mode & 0o777
      if (mode & 0o007) {
        throw new TokenInputError(
          `${label} ${JSON.stringify(path)} is accessible to other users (mode ${mode.toString(8).padStart(3, '0')}); run: chmod 600 ${path}`,
        )
      }
      if (mode & 0o070) {
        warn(`${lower} ${JSON.stringify(path)} is accessible to its group (mode ${mode.toString(8).padStart(3, '0')}); mode 600 is recommended`)
      }
    }
    const token = readFileSync(fd, 'utf-8').trim()
    if (token === '') {
      throw new TokenInputError(`${label} ${JSON.stringify(path)} is empty`)
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

/**
 * Picks the OpenClaw Gateway token. Precedence, highest first, the same
 * order as for the agent token:
 *
 *   1. `--gateway-token-file <path>`
 *   2. `OPENCLAW_GATEWAY_TOKEN` environment variable
 *   3. `--gateway-token <value>` (deprecated: the value is visible in the process list)
 *   4. `gateway.token` in the `--config` file
 *
 * A source that is set to an empty (or whitespace-only) value is ignored and
 * the next one is tried, except for `--gateway-token-file`, where an empty
 * path or an empty file is an error. The file reuses the agent token's mode
 * check, so the two files are held to one policy.
 *
 * `forwarded` is what goes to the dashboard in the `auth` message. It keeps
 * the rule that applied before the file existed: the file, the flag and the
 * config key are forwarded (in that order), the environment variable never.
 */
export function resolveGatewayToken(
  inputs: GatewayTokenInputs,
  warn: (msg: string) => void = (m) => console.error(`[clawd-agent][WARN] ${m}`),
): GatewayTokenResolution {
  const env = inputs.env ?? process.env

  const flag = inputs.tokenFlag !== undefined && inputs.tokenFlag !== '' ? inputs.tokenFlag : undefined
  if (flag !== undefined) {
    warn(`--gateway-token is deprecated: the value is visible in the process list (ps, /proc/<pid>/cmdline). Use --gateway-token-file <path> or the ${GATEWAY_TOKEN_ENV_VAR} environment variable instead.`)
  }

  const fromFile = inputs.tokenFile !== undefined ? readTokenFile(inputs.tokenFile, warn, 'Gateway token file') : undefined
  const fromEnv = env[GATEWAY_TOKEN_ENV_VAR]?.trim() || undefined
  const fromConfig = inputs.configToken !== undefined && inputs.configToken !== '' ? inputs.configToken : undefined

  return {
    token: fromFile ?? fromEnv ?? flag ?? fromConfig,
    forwarded: fromFile ?? flag ?? fromConfig,
  }
}
