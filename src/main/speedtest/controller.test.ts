import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPEEDTEST_URL, SPEEDTEST_LIMITS } from '../../shared/speedtest'
import { SpeedtestController, type SpeedtestDependencies } from './controller'
import type { ProxyGraph } from './model'

function setup(count = 2): {
  controller: SpeedtestController
  deps: SpeedtestDependencies
  graph: ProxyGraph
} {
  const graph: ProxyGraph = { Group: { name: 'Group', type: 'Selector', all: [], now: 'Node0' } }
  for (let i = 0; i < count; i++) {
    graph[`Node${i}`] = { name: `Node${i}`, type: 'Shadowsocks', id: `${i}` }
    graph.Group.all?.push(`Node${i}`)
  }
  const deps: SpeedtestDependencies = {
    prepare: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    graph: vi.fn(async () => graph),
    selectTestNode: vi.fn(async () => {}),
    download: vi.fn(async (_url, maxBytes) => ({ bytes: maxBytes, bodyMs: 1000, reason: 'limit' })),
    select: vi.fn(async (group, node) => {
      graph[group].now = node
    }),
    publish: vi.fn()
  }
  return { controller: new SpeedtestController(deps), deps, graph }
}
async function finish(controller: SpeedtestController): Promise<void> {
  await vi.waitFor(() => expect(controller.snapshot()?.phase).toBe('finished'), { interval: 1 })
}
afterEach(() => vi.useRealTimers())

describe('speed-test job ownership', () => {
  it('runs serially with both byte limits and leaves remaining nodes untested', async () => {
    const { controller, deps } = setup(12)
    controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await finish(controller)
    expect(deps.download).toHaveBeenCalledTimes(10)
    expect(controller.snapshot()?.bytes).toBe(SPEEDTEST_LIMITS.batchBytes)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'pending')).toHaveLength(2)
    expect(deps.select).not.toHaveBeenCalled()
  })
  it('rejects concurrent starts and cancels without starting another node', async () => {
    const { controller, deps } = setup()
    deps.download = vi.fn(
      async (_url, _bytes, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ bytes: 1000, bodyMs: 1000, reason: 'cancelled' }),
            { once: true }
          )
        })
    )
    controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    expect(() =>
      controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    ).toThrow('已有')
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalledTimes(1), { interval: 1 })
    controller.cancel()
    await finish(controller)
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()?.results.map((r) => r.status)).toEqual(['cancelled', 'pending'])
  })
  it('counts selection time in the five-second deadline', async () => {
    vi.useFakeTimers()
    const { controller, deps } = setup(1)
    deps.selectTestNode = vi.fn(
      async (_node, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await vi.advanceTimersByTimeAsync(5001)
    expect(controller.snapshot()?.phase).toBe('finished')
    expect(deps.download).not.toHaveBeenCalled()
    expect(controller.snapshot()?.results[0].status).toBe('failed')
  })
  it('cannot select stale, invalidated or insufficient results', async () => {
    const { controller, deps } = setup(1)
    const state = controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await finish(controller)
    await expect(controller.selectFastest('wrong')).rejects.toThrow()
    controller.invalidate('core restarted')
    await expect(controller.selectFastest(state.id)).rejects.toThrow()
    expect(deps.select).not.toHaveBeenCalled()
    deps.download = vi.fn(async () => ({ bytes: 100, bodyMs: 1000, reason: 'end' }))
    const small = controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await finish(controller)
    await expect(controller.selectFastest(small.id)).rejects.toThrow('没有有效')
  })
  it('selects only after explicit request, and only in the tested manual group', async () => {
    const { controller, deps } = setup()
    const state = controller.start({
      group: 'Group',
      mode: 'detailed',
      node: 'Node1',
      url: DEFAULT_SPEEDTEST_URL
    })
    await finish(controller)
    expect(deps.select).not.toHaveBeenCalled()
    expect(await controller.selectFastest(state.id)).toBe('Node1')
    expect(deps.select).toHaveBeenCalledWith('Group', 'Node1', expect.any(AbortSignal))
  })
  it('stops on changed provider identities instead of applying old rankings', async () => {
    const { controller, deps, graph } = setup()
    deps.download = vi.fn(async () => {
      graph.Node1.id = 'replacement'
      return { bytes: 1024 * 1024, bodyMs: 1000, reason: 'end' }
    })
    controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await finish(controller)
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()?.valid).toBe(false)
  })
  it('stops the batch on a bad source without trying another URL', async () => {
    const { controller, deps } = setup()
    deps.download = vi.fn(async () => ({
      bytes: 0,
      bodyMs: 0,
      reason: 'source-error',
      message: 'HTTP 403'
    }))
    controller.start({ group: 'Group', mode: 'detailed', url: DEFAULT_SPEEDTEST_URL })
    await finish(controller)
    expect(deps.download).toHaveBeenCalledTimes(1)
    expect(controller.snapshot()?.message).toBe('HTTP 403')
  })
  it('refuses automatic groups and never mutates nested groups implicitly', async () => {
    const { controller, deps, graph } = setup()
    graph.Group.type = 'URLTest'
    let state = controller.start({
      group: 'Group',
      mode: 'detailed',
      node: 'Node1',
      url: DEFAULT_SPEEDTEST_URL
    })
    await finish(controller)
    await expect(controller.selectFastest(state.id)).rejects.toThrow('自动')
    graph.Group = { name: 'Group', type: 'Selector', all: ['Child'] }
    graph.Child = { name: 'Child', type: 'Selector', all: ['Node0', 'Node1'], now: 'Node0' }
    state = controller.start({
      group: 'Group',
      mode: 'detailed',
      node: 'Node1',
      url: DEFAULT_SPEEDTEST_URL
    })
    await finish(controller)
    await expect(controller.selectFastest(state.id)).rejects.toThrow('嵌套')
    expect(deps.select).not.toHaveBeenCalled()
  })
})

describe('six-way quick checks', () => {
  it('runs all six with distinct slots, sums concurrent bytes and keeps every result', async () => {
    const { controller, deps } = setup(6)
    const releases: (() => void)[] = []
    const slots: number[] = []
    deps.download = vi.fn(async (_url, maxBytes, _signal, progress, slot) => {
      slots.push(slot)
      progress(1024 * 1024, 300)
      await new Promise<void>((resolve) => releases.push(resolve))
      return { bytes: maxBytes, bodyMs: 800, reason: 'limit' }
    })
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await vi.waitFor(() => expect(releases).toHaveLength(6), { interval: 1 })
    expect(new Set(slots).size).toBe(6)
    expect(controller.snapshot()?.bytes).toBe(6 * 1024 * 1024)
    releases.forEach((release) => release())
    await finish(controller)
    expect(controller.snapshot()?.results.map((r) => r.status)).toEqual(Array(6).fill('success'))
    expect(controller.snapshot()?.bytes).toBe(18 * 1024 * 1024)
    expect(deps.cleanup).toHaveBeenCalledTimes(6)
  })
  it('cancels every in-flight worker and starts no next wave', async () => {
    const { controller, deps } = setup(8)
    deps.download = vi.fn(
      async (_url, _max, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ bytes: 1024, bodyMs: 500, reason: 'cancelled' }),
            { once: true }
          )
        })
    )
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalledTimes(6), { interval: 1 })
    controller.cancel()
    await finish(controller)
    expect(deps.download).toHaveBeenCalledTimes(6)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'cancelled')).toHaveLength(6)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'pending')).toHaveLength(2)
    expect(controller.snapshot()?.bytes).toBe(6 * 1024)
  })
  it('times out all six including selection at two seconds, without calling them unusable', async () => {
    vi.useFakeTimers()
    const { controller, deps } = setup(6)
    deps.selectTestNode = vi.fn(
      async (_node, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await vi.advanceTimersByTimeAsync(2001)
    expect(controller.snapshot()?.phase).toBe('finished')
    expect(controller.snapshot()?.results.every((r) => r.status === 'insufficient')).toBe(true)
    expect(deps.download).not.toHaveBeenCalled()
  })
  it('does not rank parallel rates and prefers an already-qualified current node', async () => {
    const { controller, deps, graph } = setup(6)
    graph.Group.now = 'Node3'
    const state = controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await finish(controller)
    expect(await controller.selectFastest(state.id)).toBe('Node3')
    expect(deps.select).toHaveBeenCalledTimes(1)
  })
  it('reserves the shared batch budget before launching a wave', async () => {
    const { controller, deps } = setup(80)
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await finish(controller)
    expect(controller.snapshot()?.bytes).toBe(198 * 1024 * 1024)
    expect(deps.download).toHaveBeenCalledTimes(66)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'pending')).toHaveLength(14)
  })
  it('does not treat a late full sample or a small early response as qualified', async () => {
    vi.useFakeTimers()
    const { controller, deps } = setup(1)
    deps.download = vi.fn(async (_url, maxBytes) => {
      await new Promise((resolve) => setTimeout(resolve, 2100))
      return { bytes: maxBytes, bodyMs: 1800, reason: 'limit' }
    })
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await vi.advanceTimersByTimeAsync(2101)
    expect(controller.snapshot()?.results[0].status).toBe('insufficient')
    deps.download = vi.fn(async () => ({ bytes: 1024 * 1024, bodyMs: 100, reason: 'end' }))
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.snapshot()?.results[0].status).toBe('insufficient')
  })
  it('a source rejection on one route does not discard the other five checks', async () => {
    const { controller, deps } = setup(6)
    deps.download = vi.fn(async (_url, maxBytes, _signal, _progress, slot) => ({
      bytes: slot === 0 ? 0 : maxBytes,
      bodyMs: 500,
      reason: slot === 0 ? 'source-error' : 'limit'
    }))
    controller.start({ group: 'Group', url: DEFAULT_SPEEDTEST_URL, mode: 'quick' })
    await finish(controller)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'success')).toHaveLength(5)
    expect(controller.snapshot()?.results.filter((r) => r.status === 'failed')).toHaveLength(1)
    expect(controller.snapshot()?.valid).toBe(true)
  })
})
