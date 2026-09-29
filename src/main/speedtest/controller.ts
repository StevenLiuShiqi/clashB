import { randomUUID } from 'crypto'
import {
  DEFAULT_SPEEDTEST_URL,
  SPEEDTEST_LIMITS,
  type SpeedtestMode,
  type SpeedtestResult,
  type SpeedtestSnapshot,
  type SpeedtestStart
} from '../../shared/speedtest'
import {
  expandNodes,
  graphFingerprint,
  manualPath,
  sampleStatus,
  validateSource,
  type ProxyGraph
} from './model'
import type { Sample } from './download'

export interface SpeedtestDependencies {
  prepare: (signal: AbortSignal, mode: SpeedtestMode) => Promise<void>
  graph: (signal: AbortSignal) => Promise<ProxyGraph>
  selectTestNode: (node: string, signal: AbortSignal, slot: number) => Promise<void>
  download: (
    url: string,
    maxBytes: number,
    signal: AbortSignal,
    progress: (bytes: number, ms: number) => void,
    slot: number
  ) => Promise<Sample>
  select: (group: string, node: string, signal: AbortSignal) => Promise<void>
  cleanup: (slot: number) => Promise<void>
  publish: (snapshot: SpeedtestSnapshot) => void
}

export class SpeedtestController {
  private state: SpeedtestSnapshot | null = null
  private abort: AbortController | undefined
  private fingerprint = ''
  private selecting = false
  constructor(private readonly deps: SpeedtestDependencies) {}

  snapshot(): SpeedtestSnapshot | null {
    return this.state ? structuredClone(this.state) : null
  }
  private publish(): void {
    if (this.state) this.deps.publish(structuredClone(this.state))
  }
  cancel(): void {
    this.abort?.abort(new Error('cancelled'))
  }
  invalidate(reason: string): void {
    if (!this.state) return
    this.state.valid = false
    this.state.message = reason
    this.abort?.abort(new Error(reason))
    this.publish()
  }
  start(input: SpeedtestStart): SpeedtestSnapshot {
    if (this.selecting || (this.state && this.state.phase !== 'finished'))
      throw new Error('已有测速任务，请先取消或等待完成')
    if (
      !input ||
      typeof input.group !== 'string' ||
      !input.group ||
      input.group.length > 1024 ||
      (input.node !== undefined && (typeof input.node !== 'string' || input.node.length > 1024)) ||
      (input.mode !== undefined && input.mode !== 'quick' && input.mode !== 'detailed')
    )
      throw new Error('测速参数无效')
    const mode = input.mode ?? 'quick'
    let url = validateSource(input.url)
    if (mode === 'quick' && url === DEFAULT_SPEEDTEST_URL) {
      const source = new URL(url)
      source.searchParams.set('bytes', String(SPEEDTEST_LIMITS.quickNodeBytes))
      url = source.toString()
    }
    this.abort = new AbortController()
    this.state = {
      id: randomUUID(),
      group: input.group,
      mode,
      url,
      phase: 'preparing',
      startedAt: Date.now(),
      results: [],
      bytes: 0,
      valid: true
    }
    this.publish()
    void this.run({ ...input, mode, url }, this.abort)
    return structuredClone(this.state)
  }

  private updateBytes(state: SpeedtestSnapshot): void {
    // Each worker owns one result. Never overwrite total bytes with a single worker's progress.
    state.bytes = state.results.reduce((total, result) => total + result.bytes, 0)
  }

  private async testNode(
    state: SpeedtestSnapshot,
    result: SpeedtestResult,
    slot: number,
    maxBytes: number,
    abort: AbortController
  ): Promise<void> {
    const quick = state.mode === 'quick'
    const nodeMs = quick ? SPEEDTEST_LIMITS.quickNodeMs : SPEEDTEST_LIMITS.nodeMs
    const nodeAbort = new AbortController()
    const cancelNode = (): void => nodeAbort.abort(abort.signal.reason)
    abort.signal.addEventListener('abort', cancelNode, { once: true })
    if (abort.signal.aborted) cancelNode()
    const started = performance.now()
    const timer = setTimeout(() => nodeAbort.abort(new Error('deadline')), nodeMs)
    result.status = 'running'
    this.publish()
    try {
      nodeAbort.signal.throwIfAborted()
      const fresh = await this.deps.graph(nodeAbort.signal)
      if (graphFingerprint(fresh) !== this.fingerprint)
        this.invalidate('节点或订阅已变化，请重新测速')
      nodeAbort.signal.throwIfAborted()
      await this.deps.selectTestNode(result.node, nodeAbort.signal, slot)
      nodeAbort.signal.throwIfAborted()
      let lastProgress = 0
      const sample = await this.deps.download(
        state.url,
        maxBytes,
        nodeAbort.signal,
        (bytes, ms) => {
          result.bytes = bytes
          result.bodyMs = ms
          result.elapsedMs = performance.now() - started
          this.updateBytes(state)
          if (performance.now() - lastProgress >= 200) {
            lastProgress = performance.now()
            this.publish()
          }
        },
        slot
      )
      result.elapsedMs = performance.now() - started
      result.bytes = sample.bytes
      result.bodyMs = sample.bodyMs
      result.bytesPerSecond = sample.bodyMs > 0 ? (sample.bytes * 1000) / sample.bodyMs : 0
      const reason = sample.reason === 'source-error' ? 'error' : sample.reason
      result.status = sampleStatus(sample.bytes, sample.bodyMs, reason)
      result.message = sample.message
      if (quick && reason !== 'error' && reason !== 'cancelled') {
        result.status =
          sample.bytes >= SPEEDTEST_LIMITS.quickNodeBytes &&
          result.elapsedMs <= nodeMs &&
          (reason === 'end' || reason === 'limit')
            ? 'success'
            : 'insufficient'
        result.message =
          result.status === 'success'
            ? '2 秒内完成 3 MiB 下载，快速检查达标'
            : '未快速达标；并行任务共享带宽，不代表无法播放视频，可单独复查'
      } else if (result.status === 'insufficient') {
        result.message = '样本不足（至少 1 MiB 且下载 0.5 秒），不参与最快排名'
      }
      if (sample.reason === 'source-error' && !quick) {
        state.message = sample.message
        state.valid = false
        abort.abort(new Error('source-error'))
      }
    } catch (error) {
      const deadline = nodeAbort.signal.reason?.message === 'deadline'
      result.status = abort.signal.aborted
        ? 'cancelled'
        : quick && deadline
          ? 'insufficient'
          : 'failed'
      result.message = deadline
        ? quick
          ? '2 秒内未快速达标，可单独复查；不代表线路不可用'
          : '5 秒内未能开始有效下载'
        : String(error)
      result.elapsedMs = performance.now() - started
    } finally {
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', cancelNode)
      this.updateBytes(state)
      try {
        await this.deps.cleanup(slot)
      } catch {
        this.invalidate('无法确认测速连接已清理，已停止后续测试；请检查内核状态')
      }
      result.testedAt = Date.now()
      this.publish()
    }
  }

  private async run(input: SpeedtestStart, abort: AbortController): Promise<void> {
    const state = this.state
    if (!state) return
    const quick = state.mode === 'quick'
    const concurrency = quick ? SPEEDTEST_LIMITS.quickConcurrency : 1
    const nodeBytes = quick ? SPEEDTEST_LIMITS.quickNodeBytes : SPEEDTEST_LIMITS.nodeBytes
    const timer = setTimeout(
      () => abort.abort(new Error('batch-deadline')),
      SPEEDTEST_LIMITS.batchMs
    )
    try {
      await this.deps.prepare(abort.signal, state.mode)
      abort.signal.throwIfAborted()
      const graph = await this.deps.graph(abort.signal)
      abort.signal.throwIfAborted()
      if (!graph[input.group]?.all) throw new Error('代理组已不存在，请刷新')
      this.fingerprint = graphFingerprint(graph)
      const nodes = expandNodes(graph, input.group)
      if (input.node && !nodes.includes(input.node))
        throw new Error('所选节点不属于该组或不是实际代理节点')
      const targets = input.node ? [input.node] : nodes
      if (!targets.length) throw new Error('该组没有可测试的实际代理节点')
      state.results = targets.map((node) => ({
        node,
        status: 'pending',
        bytes: 0,
        bodyMs: 0,
        bytesPerSecond: 0
      }))
      state.phase = 'running'
      this.publish()
      let next = 0
      let reserved = 0
      let settled = 0
      const worker = async (slot: number): Promise<void> => {
        while (next < state.results.length && !abort.signal.aborted) {
          const available = SPEEDTEST_LIMITS.batchBytes - settled - reserved
          if (available <= 0 || (quick && available < nodeBytes)) return
          const maxBytes = Math.min(nodeBytes, available)
          const result = state.results[next++]
          // Synchronous reservation precedes the first await, so workers cannot oversubscribe.
          reserved += maxBytes
          try {
            await this.testNode(state, result, slot, maxBytes, abort)
          } finally {
            reserved -= maxBytes
            settled += result.bytes
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, (_, slot) => worker(slot))
      )
      if (!state.message)
        state.message = abort.signal.aborted
          ? '任务已停止，剩余节点未测试'
          : state.results.some((r) => r.status === 'pending')
            ? '已达到整批预算，剩余节点未测试'
            : quick
              ? `快速检查完成：${state.results.filter((r) => r.status === 'success').length} / ${state.results.length} 达标`
              : '本轮测速完成'
    } catch (error) {
      state.message = abort.signal.aborted ? '任务已取消或已达到整批时间上限' : String(error)
      state.valid = false
    } finally {
      clearTimeout(timer)
      if (state.results.length === 0) {
        await Promise.all(
          Array.from({ length: concurrency }, (_, slot) => this.deps.cleanup(slot).catch(() => {}))
        )
      }
      state.phase = 'finished'
      this.abort = undefined
      this.publish()
    }
  }

  async selectFastest(id: string): Promise<string> {
    const state = this.state
    if (!state || state.id !== id || !state.valid || state.phase !== 'finished' || this.selecting)
      throw new Error('本轮结果不可用，请重新测速')
    const candidates = state.results.filter((r) => r.status === 'success')
    if (!candidates.length) throw new Error('没有有效测速结果，不能选择节点')
    this.selecting = true
    const controller = new AbortController()
    this.abort = controller
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const graph = await this.deps.graph(controller.signal)
      if (!state.valid || graphFingerprint(graph) !== this.fingerprint)
        throw new Error('节点或配置已变化，请重新测速')
      if (state.mode === 'quick') {
        // No speed ranking under contention. Prefer keeping a qualified current selection.
        candidates.sort(
          (a, b) =>
            Number(b.node === graph[state.group]?.now) - Number(a.node === graph[state.group]?.now)
        )
      } else candidates.sort((a, b) => b.bytesPerSecond - a.bytesPerSecond)
      const best = candidates[0]
      const path = manualPath(graph, state.group, best.node)
      if (!path) throw new Error('候选节点位于自动选择组，不能稳定手动切换；请在手动选择组中测试')
      if (path.slice(0, -1).some((step) => graph[step.group]?.now !== step.node))
        throw new Error('候选节点位于嵌套组；为避免修改其他代理组，请打开对应子组进行测速和切换')
      for (const step of path.slice(-1)) {
        controller.signal.throwIfAborted()
        if (!state.valid) throw new Error('配置已变化')
        await this.deps.select(step.group, step.node, controller.signal)
      }
      const after = await this.deps.graph(controller.signal)
      if (!state.valid || path.some((step) => after[step.group]?.now !== step.node))
        throw new Error('选择已被其他操作改变，请检查当前节点')
      return best.node
    } finally {
      clearTimeout(timeout)
      this.abort = undefined
      this.selecting = false
    }
  }
}
