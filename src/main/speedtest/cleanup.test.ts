import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainTestConnections } from './cleanup'

afterEach(() => vi.useRealTimers())
describe('parallel connection cleanup acknowledgement', () => {
  it('waits for late connection entries and only closes its own listener', async () => {
    vi.useFakeTimers()
    let calls = 0
    const close = vi.fn(async () => {})
    const reset = vi.fn(async () => {})
    const done = drainTestConnections(
      'slot-a',
      {
        reset,
        close,
        list: async () => {
          calls++
          return [
            { id: 'other', metadata: { inboundName: 'slot-b' } },
            ...(calls === 1 ? [{ id: 'first', metadata: { inboundName: 'slot-a' } }] : []),
            ...(calls === 3 ? [{ id: 'late', metadata: { specialProxy: 'slot-a' } }] : [])
          ]
        }
      },
      new AbortController().signal
    )
    await vi.advanceTimersByTimeAsync(450)
    await done
    expect(reset).toHaveBeenCalledOnce()
    expect(close.mock.calls).toEqual([['first'], ['late']])
    expect(calls).toBeGreaterThan(4)
  })
  it('fails rather than acknowledging cleanup when a connection will not disappear', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const done = drainTestConnections(
      'slot-a',
      {
        reset: async () => {},
        close: async () => {},
        list: async () => [{ id: 'stuck', metadata: { inboundName: 'slot-a' } }]
      },
      controller.signal
    )
    const check = expect(done).rejects.toThrow()
    setTimeout(() => controller.abort(new Error('cleanup timeout')), 500)
    await vi.advanceTimersByTimeAsync(501)
    await check
  })
})
