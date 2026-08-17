import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node:fs/promises (async fs used by sessions.ts)
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

// Mock node:os so sessionsDir is deterministic
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}))

import { readdir, readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { collectSessions } from '../collectors/sessions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Build a fake Stats object with the given mtime. */
function fakeStat(mtime = new Date('2024-01-01T00:00:00Z')): Stats {
  return { mtime } as unknown as Stats
}

/** Serialise JSONL rows. */
function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

/** Standard session-entry JSONL. */
function sessionEntry(id: string) {
  return { type: 'session', id, timestamp: '2024-01-01T00:00:00Z' }
}

function msgEntry(role: 'user' | 'assistant', content: string | unknown[], ts: string) {
  return { type: 'message', message: { role, content }, timestamp: ts }
}

describe('collectSessions', () => {
  beforeEach(() => {
    vi.mocked(readdir).mockReset()
    vi.mocked(readFile).mockReset()
    vi.mocked(stat).mockReset()

    // Sensible defaults
    vi.mocked(stat).mockResolvedValue(fakeStat())
  })

  // -------------------------------------------------------------------------
  // readdir fails → empty array (outer catch)
  // -------------------------------------------------------------------------
  it('returns [] when sessionsDir is unreadable', async () => {
    vi.mocked(readdir).mockRejectedValue(new Error('ENOENT'))
    const result = await collectSessions('http://gw', undefined)
    expect(result).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Empty session (messageCount === 0) skipped
  // -------------------------------------------------------------------------
  it('skips sessions with no user/assistant messages', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-empty.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([sessionEntry('empty-session')])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Malformed JSONL line skipped without throwing
  // -------------------------------------------------------------------------
  it('skips malformed JSONL lines without throwing', async () => {
    vi.mocked(readdir).mockResolvedValue(['s.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      [
        JSON.stringify(sessionEntry('sess1')),
        'NOT VALID JSON {{{',  // malformed — must be skipped
        JSON.stringify(msgEntry('user', 'hello', '2024-01-01T00:01:00Z')),
      ].join('\n')
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1)
  })

  // -------------------------------------------------------------------------
  // String content extraction
  // -------------------------------------------------------------------------
  it('extracts string content from message entries', async () => {
    vi.mocked(readdir).mockResolvedValue(['s.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-str'),
        msgEntry('user', 'hello world', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].recentMessages?.[0]?.content).toBe('hello world')
    expect(result[0].recentMessages?.[0]?.role).toBe('user')
  })

  // -------------------------------------------------------------------------
  // Array-of-blocks content extraction
  // -------------------------------------------------------------------------
  it('extracts text from content-block arrays', async () => {
    vi.mocked(readdir).mockResolvedValue(['s.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-blocks'),
        msgEntry(
          'assistant',
          [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'tu1' }, // non-text block — ignored
            { type: 'text', text: 'World' },
          ],
          '2024-01-01T00:02:00Z'
        ),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    const content = result[0].recentMessages?.[0]?.content ?? ''
    expect(content).toContain('Hello')
    expect(content).toContain('World')
  })

  // -------------------------------------------------------------------------
  // Recent-message slicing (MAX_RECENT_MESSAGES = 5)
  // -------------------------------------------------------------------------
  it('returns only the last 5 messages (MAX_RECENT_MESSAGES)', async () => {
    vi.mocked(readdir).mockResolvedValue(['s.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)

    // 8 messages → only last 5 should appear in recentMessages
    const rows: unknown[] = [sessionEntry('sess-many')]
    for (let i = 1; i <= 8; i++) {
      rows.push(msgEntry('user', `msg-${i}`, `2024-01-01T00:0${i}:00Z`))
    }
    vi.mocked(readFile).mockResolvedValue(jsonl(rows))

    const result = await collectSessions('http://gw')
    expect(result[0].messageCount).toBe(8)
    expect(result[0].recentMessages).toHaveLength(5)
    // Last 5 should be msg-4 through msg-8
    expect(result[0].recentMessages?.[0]?.content).toBe('msg-4')
    expect(result[0].recentMessages?.[4]?.content).toBe('msg-8')
  })

  // -------------------------------------------------------------------------
  // Sort by lastMessageAt (newest first) + 20-session cap
  // -------------------------------------------------------------------------
  it('returns at most 20 sessions, sorted newest-first', async () => {
    // Create 25 JSONL file names
    const files = Array.from({ length: 25 }, (_, i) => `sess-${i}.jsonl`)
    vi.mocked(readdir).mockResolvedValue(files as unknown as Awaited<ReturnType<typeof readdir>>)

    vi.mocked(stat).mockResolvedValue(fakeStat())
    vi.mocked(readFile).mockImplementation(async (path) => {
      const p = String(path)
      const idxMatch = p.match(/sess-(\d+)\.jsonl$/)
      const idx = idxMatch ? parseInt(idxMatch[1]) : 0
      const ts = `2024-01-${String(idx + 1).padStart(2, '0')}T00:00:00Z`
      return jsonl([
        sessionEntry(`session-${idx}`),
        msgEntry('user', `msg from session ${idx}`, ts),
      ])
    })

    const result = await collectSessions('http://gw')
    expect(result.length).toBe(20) // cap at 20

    // First result must be the session with the newest timestamp (idx=24)
    expect(result[0].recentMessages?.[0]?.content).toBe('msg from session 24')
  })

  // -------------------------------------------------------------------------
  // model_change entry sets session.model (split-and-pop of modelId)
  // -------------------------------------------------------------------------
  it('extracts model from model_change entry (split on / and pop)', async () => {
    vi.mocked(readdir).mockResolvedValue(['s.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-model'),
        { type: 'model_change', modelId: 'anthropic/claude-opus-4', timestamp: '2024-01-01T00:00:30Z' },
        msgEntry('user', 'hello', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    // modelId.split('/').pop() must yield the short model name
    expect(result[0].model).toBe('claude-opus-4')
  })

  // -------------------------------------------------------------------------
  // .lock / .deleted / .reset files excluded
  // -------------------------------------------------------------------------
  it('ignores lock, deleted, and reset files', async () => {
    vi.mocked(readdir).mockResolvedValue([
      'valid.jsonl',
      'valid.jsonl.lock',
      'del.jsonl.deleted',
      'rst.jsonl.reset',
    ] as unknown as Awaited<ReturnType<typeof readdir>>)

    vi.mocked(readFile).mockResolvedValue(
      jsonl([sessionEntry('v1'), msgEntry('user', 'hi', '2024-01-01T00:00:01Z')])
    )

    const result = await collectSessions('http://gw')
    // Only 'valid.jsonl' is read; the others are filtered out
    expect(result).toHaveLength(1)
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // entry.id not a string -> sessionKey stays undefined at parse time and
  // falls back to the filename-derived key at push time.
  // -------------------------------------------------------------------------
  it('falls back to filename-derived sessionKey when session id is not a string', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-noid.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        { type: 'session', id: 12345, timestamp: '2024-01-01T00:00:00Z' }, // id is a number, not a string
        msgEntry('user', 'hi', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].sessionKey).toBe('agent:main:sess-noid')
  })

  // -------------------------------------------------------------------------
  // role neither 'user' nor 'assistant' -> message is skipped entirely
  // -------------------------------------------------------------------------
  it('does not count or extract messages with a non-user/assistant role', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-role.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-role'),
        { type: 'message', message: { role: 'system', content: 'system prompt' }, timestamp: '2024-01-01T00:00:30Z' },
        msgEntry('user', 'hi', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1) // the system message is not counted
    expect(result[0].recentMessages).toHaveLength(1)
    expect(result[0].recentMessages?.[0]?.role).toBe('user')
  })

  // -------------------------------------------------------------------------
  // message entry with no `message` field -> msg?.role is undefined via
  // optional chaining, so the role guard's condition is false.
  // -------------------------------------------------------------------------
  it('skips a message entry that has no message payload', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-nomsg.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-nomsg'),
        { type: 'message', timestamp: '2024-01-01T00:00:30Z' }, // no `message` field at all
        msgEntry('user', 'hi', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1)
    // the counted message must be the trailing 'hi' one, not the no-payload entry
    expect(result[0].recentMessages).toHaveLength(1)
    expect(result[0].recentMessages?.[0]?.content).toBe('hi')
  })

  // -------------------------------------------------------------------------
  // content is neither a string nor an array -> content stays '' but the
  // message is still counted (messageCount++ happens before content is read)
  // -------------------------------------------------------------------------
  it('counts but does not extract content when message content is neither string nor array', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-badcontent.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-badcontent'),
        { type: 'message', message: { role: 'user', content: 42 }, timestamp: '2024-01-01T00:01:00Z' },
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1)
    expect(result[0].recentMessages).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // content-block array where every block is non-text (or null) -> the
  // joined content is '' and the message is not pushed to recentMessages
  // -------------------------------------------------------------------------
  it('does not push a message when a content-block array yields no text', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-notext.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-notext'),
        msgEntry('assistant', [{ type: 'tool_use', id: 'tu1' }, null], '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1)
    expect(result[0].recentMessages).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // text block with a missing `text` field falls back to '' via `?? ''`
  // -------------------------------------------------------------------------
  it('falls back to an empty string for a text block with no text field', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-emptytext.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-emptytext'),
        msgEntry('assistant', [{ type: 'text' }, { type: 'text', text: 'ok' }], '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].recentMessages?.[0]?.content).toBe('ok')
  })

  // -------------------------------------------------------------------------
  // message entry with a non-string timestamp does not update lastMessageAt;
  // with no valid timestamp anywhere in the file, the session falls back to
  // the file's mtime.
  // -------------------------------------------------------------------------
  it('falls back to file mtime for lastMessageAt when no message has a string timestamp', async () => {
    const mtime = new Date('2024-06-01T00:00:00Z')
    vi.mocked(readdir).mockResolvedValue(['sess-notime.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(stat).mockResolvedValue(fakeStat(mtime))
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-notime'),
        { type: 'message', message: { role: 'user', content: 'hi' }, timestamp: 12345 }, // not a string
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].lastMessageAt).toBe(mtime.toISOString())
  })

  // -------------------------------------------------------------------------
  // entry.type matches none of 'session' / 'message' / 'model_change' -> the
  // whole if/else-if chain falls through without touching any state.
  // -------------------------------------------------------------------------
  it('ignores JSONL entries with an unrecognized type', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-unknown.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-unknown'),
        // unrecognized event type carrying a modelId -- must NOT be picked up
        // as if it were a model_change entry
        { type: 'heartbeat', modelId: 'anthropic/should-not-apply', timestamp: '2024-01-01T00:00:30Z' },
        msgEntry('user', 'hi', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].messageCount).toBe(1)
    expect(result[0].model).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // model_change entry with a non-string modelId leaves model undefined
  // -------------------------------------------------------------------------
  it('leaves model undefined when model_change modelId is not a string', async () => {
    vi.mocked(readdir).mockResolvedValue(['sess-badmodel.jsonl'] as unknown as Awaited<ReturnType<typeof readdir>>)
    vi.mocked(readFile).mockResolvedValue(
      jsonl([
        sessionEntry('sess-badmodel'),
        { type: 'model_change', modelId: 12345, timestamp: '2024-01-01T00:00:30Z' },
        msgEntry('user', 'hi', '2024-01-01T00:01:00Z'),
      ])
    )

    const result = await collectSessions('http://gw')
    expect(result).toHaveLength(1)
    expect(result[0].model).toBeUndefined()
  })
})
