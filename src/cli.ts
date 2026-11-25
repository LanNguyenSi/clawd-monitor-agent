#!/usr/bin/env node
import { loadConfig } from './config.js'
import { Agent } from './agent.js'
import { VERSION } from './version.js'

function printHelp() {
  console.log(`
clawd-monitor-agent v${VERSION}
Lightweight agent that pushes OpenClaw instance data to clawd-monitor.

Usage:
  clawd-monitor-agent --server <url> --token-file <path> [options]

Options:
  --server <url>           clawd-monitor server URL (required)
  --token-file <path>      File holding the agent token (mode 600; recommended)
  --token <token>          Agent token on the command line (deprecated: visible in ps)
  --name <name>            Agent display name (default: hostname)
  --gateway <url>          OpenClaw Gateway URL (default: http://localhost:18789)
  --gateway-token-file <path>
                           File holding the OpenClaw Gateway API token (mode 600; recommended)
  --gateway-token <token>  OpenClaw Gateway API token on the command line (deprecated: visible in ps)
  --clawd-dir <path>       Path to OpenClaw workspace
  --interval <ms>          Push interval in ms, a number (default: 5000, min: 1000, max: 2147483647)
  --config <path>          Path to JSON config file
  --no-memory              Disable memory file collection
  --no-docker              Disable docker collection
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show this help

The agent token comes from the first of these that is set: --token-file,
the CLAWD_AGENT_TOKEN environment variable, --token, "token" in --config.
The Gateway token comes from the first of these that is set:
--gateway-token-file, the OPENCLAW_GATEWAY_TOKEN environment variable,
--gateway-token, "gateway.token" in --config.
`)
}

export function parseArgs(): Record<string, string | boolean> {
  const args = process.argv.slice(2)
  const result: Record<string, string | boolean> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    if (arg === '--version') { console.log(VERSION); process.exit(0) }
    if (arg === '--no-memory') { result.memory = false; continue }
    if (arg === '--no-docker') { result.docker = false; continue }
    if (arg === '--debug') { result.debug = true; continue }

    // --token-file and --gateway-token-file accept both the space form and the
    // equals form (--token-file=/path). The equals form splits at the first
    // '=', so the path may itself contain '='.
    const eq = arg.indexOf('=')
    const flagName = eq === -1 ? arg : arg.slice(0, eq)
    if (flagName === '--token-file' || flagName === '--gateway-token-file') {
      let value: string
      if (eq === -1) {
        const hasValue = i + 1 < args.length && !args[i + 1].startsWith('--')
        value = hasValue ? args[++i] : ''
      } else {
        value = arg.slice(eq + 1)
      }
      if (value === '') {
        console.error(`Error: ${flagName} needs a path`)
        process.exit(1)
      }
      result[flagName.slice(2)] = value
      continue
    }

    if (arg.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      result[arg.slice(2)] = args[++i]
    }
  }

  return result
}

function main() {
  const args = parseArgs()
  const config = loadConfig(args as any)

  const agent = new Agent(config)
  agent.start()

  // Graceful shutdown
  process.on('SIGINT', () => { agent.stop(); process.exit(0) })
  process.on('SIGTERM', () => { agent.stop(); process.exit(0) })

  console.log(`[clawd-agent] Starting "${config.name}" → ${config.server}`)
  console.log(`[clawd-agent] Gateway: ${config.gateway.url}`)
  console.log(`[clawd-agent] Push interval: ${config.intervalMs}ms`)
}

// Entrypoint guard: prevents top-level execution when this module is imported
// by tests or other modules; only runs when invoked directly as the main script.
if (require.main === module) {
  main()
}
