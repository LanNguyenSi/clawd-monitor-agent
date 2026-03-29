import { readFileSync } from 'fs'
import type { SystemMetrics } from '../types.js'

let prevCpuIdle = 0
let prevCpuTotal = 0

function readCpuPercent(): number {
  try {
    const stat = readFileSync('/proc/stat', 'utf-8')
    const parts = stat.split('\n')[0].split(/\s+/).slice(1).map(Number)
    const idle = parts[3] + (parts[4] ?? 0)
    const total = parts.reduce((a, b) => a + b, 0)
    const diffIdle = idle - prevCpuIdle
    const diffTotal = total - prevCpuTotal
    const cpu = diffTotal > 0 ? Math.round((1 - diffIdle / diffTotal) * 100) : 0
    prevCpuIdle = idle
    prevCpuTotal = total
    return Math.max(0, Math.min(100, cpu))
  } catch {
    return 0
  }
}

function readMemory(): { used: number; total: number } {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8')
    const get = (key: string) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`))
      return m ? parseInt(m[1]) * 1024 : 0
    }
    const total = get('MemTotal')
    const free = get('MemFree')
    const buffers = get('Buffers')
    const cached = get('Cached')
    return { used: Math.max(0, total - free - buffers - cached), total }
  } catch {
    return { used: 0, total: 0 }
  }
}

function readUptime(): number {
  try {
    const uptime = readFileSync('/proc/uptime', 'utf-8')
    return Math.floor(parseFloat(uptime.split(' ')[0]))
  } catch {
    return 0
  }
}

export function collectMetrics(): SystemMetrics {
  const cpu = readCpuPercent()
  const mem = readMemory()
  return {
    cpuPercent: cpu,
    memUsedBytes: mem.used,
    memTotalBytes: mem.total,
    uptimeSeconds: readUptime(),
  }
}
