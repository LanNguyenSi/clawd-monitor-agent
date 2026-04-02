import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { MemoryFiles } from '../types.js'

const MAX_BYTES = 10 * 1024 // 10KB per file

function safeRead(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    const content = readFileSync(filePath, 'utf-8')
    // Truncate if over limit
    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
      return content.slice(0, MAX_BYTES) + '\n\n[... truncated ...]'
    }
    return content
  } catch {
    return undefined
  }
}

function datePath(clawdDir: string, date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return join(clawdDir, 'memory', `${y}-${m}-${day}.md`)
}

export function collectMemory(clawdDir: string): MemoryFiles {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  return {
    memory:    safeRead(join(clawdDir, 'MEMORY.md')),
    current:   safeRead(join(clawdDir, 'CURRENT.md')),
    today:     safeRead(datePath(clawdDir, now)),
    yesterday: safeRead(datePath(clawdDir, yesterday)),
  }
}
