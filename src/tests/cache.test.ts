import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cachedCall, clearCache } from '../collectors/cache.js'

describe('cachedCall', () => {
  beforeEach(() => {
    clearCache()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('shares one in-flight call and reuses the result within the TTL', async () => {
    const fn = vi.fn().mockResolvedValue('v')
    const [a, b] = await Promise.all([cachedCall('k', 1000, fn), cachedCall('k', 1000, fn)])
    expect([a, b]).toEqual(['v', 'v'])
    await cachedCall('k', 1000, fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('calls again after the TTL expires', async () => {
    const fn = vi.fn().mockResolvedValue('v')
    await cachedCall('k', 1000, fn)
    vi.advanceTimersByTime(1001)
    await cachedCall('k', 1000, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('keeps keys independent', async () => {
    const fn = vi.fn().mockResolvedValue('v')
    await cachedCall('a', 1000, fn)
    await cachedCall('b', 1000, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('caches failures only briefly (<= 10 s) so they are retried', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok')
    await expect(cachedCall('k', 60_000, fn)).rejects.toThrow('x')
    await expect(cachedCall('k', 60_000, fn)).rejects.toThrow('x') // still cached
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_001)
    await expect(cachedCall('k', 60_000, fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
