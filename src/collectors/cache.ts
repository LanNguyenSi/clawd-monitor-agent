/**
 * Tiny TTL cache with single-flight. The snapshot loop runs every 5 s, but the
 * `openclaw` CLI cold-starts a Node process (~3 s of CPU). Without this the
 * calls overlap and saturate the host, so CLI-backed collectors share one
 * in-flight call and reuse the result for `ttlMs`. Failures are cached for a
 * shorter time so a broken CLI is retried, but not every 5 s.
 */
interface Entry {
  at: number
  ttl: number
  promise: Promise<unknown>
}

const entries = new Map<string, Entry>()
const FAILURE_TTL_MS = 10_000

export function cachedCall<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = entries.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise as Promise<T>

  const entry: Entry = { at: Date.now(), ttl: ttlMs, promise: undefined as unknown as Promise<T> }
  entry.promise = fn().catch((err: unknown) => {
    entry.ttl = Math.min(ttlMs, FAILURE_TTL_MS)
    throw err
  })
  entries.set(key, entry)
  return entry.promise as Promise<T>
}

export function clearCache(): void {
  entries.clear()
}
