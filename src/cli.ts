#!/usr/bin/env node
import { loadConfig } from './config.js'
import { Agent } from './agent.js'

const VERSION = '1.0.0'

function printHelp() {
  console.log(`
clawd-monitor-agent v${VERSION}
Lightweight agent that pushes OpenClaw instance data to clawd-monitor.

Usage:
  clawd-monitor-agent --server <url> --token <token> [options]

Options:
  --server <url>           clawd-monitor server URL (required)
  --token <token>          Agent authentication token (required)
  --name <name>            Agent display name (default: hostname)
  --gateway <url>          OpenClaw Gateway URL (default: http://localhost:18789)
  --gateway-token <token>  OpenClaw Gateway API token
  --clawd-dir <path>       Path to OpenClaw workspace
  --interval <ms>          Push interval in ms (default: 5000, min: 1000)
  --config <path>          Path to JSON config file
  --no-memory              Disable memory file collection
  --no-docker              Disable docker collection
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show this help
`)
}

function parseArgs(): Record<string, string | boolean> {
  const args = process.argv.slice(2)
  const result: Record<string, string | boolean> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    if (arg === '--version') { console.log(VERSION); process.exit(0) }
    if (arg === '--no-memory') { result.memory = false; continue }
    if (arg === '--no-docker') { result.docker = false; continue }
    if (arg === '--debug') { result.debug = true; continue }

    if (arg.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      result[arg.slice(2)] = args[++i]
    }
  }

  return result
}

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
