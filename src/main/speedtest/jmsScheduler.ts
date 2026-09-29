import { getAppConfig, subscribeAppConfig } from '../config'
import { mihomoChangeProxy, mihomoGroups } from '../core/mihomoApi'
import { mainWindow } from '../window'
import { DEFAULT_SPEEDTEST_URL, type SpeedtestSnapshot } from '../../shared/speedtest'
import { JMS_AUTO_BANDWIDTH_GROUP, type JmsMetricsSnapshot } from '../../shared/jms-speedtest'
import { speedtestCancel, speedtestSnapshot, speedtestStart } from './service'

const INITIAL_DELAY_MS = 3000
let timer: NodeJS.Timeout | null = null
let stopConfigSubscription: (() => void) | null = null
let activeJob: Promise<void> | null = null
let started = false
let lastSnapshot: JmsMetricsSnapshot | null = null

function publish(snapshot: JmsMetricsSnapshot): void {
  lastSnapshot = snapshot
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('jmsMetricsUpdated', snapshot)
}

function intervalMs(minutes: number | undefined): number {
  return (minutes || 0) * 60 * 1000
}

async function waitForFinished(id: string): Promise<SpeedtestSnapshot | null> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const snapshot = await speedtestSnapshot()
    if (!snapshot || snapshot.id !== id) return null
    if (snapshot.phase === 'finished') return snapshot
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await speedtestCancel()
  return speedtestSnapshot()
}

async function runOnce(): Promise<void> {
  if (activeJob) return activeJob
  activeJob = (async () => {
    const groups = await mihomoGroups(true)
    const source = groups.find((group) => group.name === 'JMS' && group.type === 'Selector')
    if (!source) return
    const startedSnapshot = await speedtestStart({
      group: source.name,
      url: DEFAULT_SPEEDTEST_URL,
      mode: 'quick'
    })
    const snapshot = await waitForFinished(startedSnapshot.id)
    if (!snapshot || snapshot.group !== source.name) return
    const currentGroups = await mihomoGroups(true)
    const currentSource = currentGroups.find((group) => group.name === source.name)
    const pingByNode = new Map(
      (currentSource?.all ?? []).map((proxy) => {
        const history = proxy.history ?? []
        return [proxy.name, history.length > 0 ? history[history.length - 1].delay : 0] as const
      })
    )
    const metrics = snapshot.results.map((result) => ({
      node: result.node,
      ping: pingByNode.get(result.node) ?? 0,
      bandwidthMbps: (result.bytesPerSecond * 8) / 1_000_000,
      status: ['success', 'insufficient', 'failed', 'cancelled'].includes(result.status)
        ? (result.status as 'success' | 'insufficient' | 'failed' | 'cancelled')
        : 'failed',
      testedAt: result.testedAt ?? Date.now()
    }))
    const valid = metrics.filter((metric) => metric.status === 'success')
    const measured = metrics.filter(
      (metric) =>
        metric.bandwidthMbps > 0 && metric.status !== 'failed' && metric.status !== 'cancelled'
    )
    const best = (valid.length > 0 ? valid : measured).sort(
      (a, b) => b.bandwidthMbps - a.bandwidthMbps
    )[0]
    if (best) {
      try {
        await mihomoChangeProxy(JMS_AUTO_BANDWIDTH_GROUP, best.node)
      } catch {
        // The derived group may not exist in a profile that predates this feature.
      }
    }
    publish({ sourceGroup: source.name, metrics, updatedAt: Date.now() })
  })()
    .catch((error) => {
      publish({ sourceGroup: 'JMS', metrics: [], updatedAt: Date.now(), error: String(error) })
    })
    .finally(() => {
      activeJob = null
    })
  return activeJob
}

function schedule(minutes: number | undefined, initial = false): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!minutes || !started) return
  const delay = intervalMs(minutes)
  timer = setTimeout(
    () => {
      void runOnce().finally(() => schedule(minutes))
    },
    initial ? INITIAL_DELAY_MS : delay
  )
}

export async function startJmsBandwidthScheduler(): Promise<void> {
  if (started) return
  started = true
  stopConfigSubscription = subscribeAppConfig((config) =>
    schedule(config.jmsBandwidthCheckIntervalMinutes)
  )
  const config = await getAppConfig()
  if (config.jmsBandwidthCheckIntervalMinutes) {
    void runOnce().finally(() => schedule(config.jmsBandwidthCheckIntervalMinutes))
  }
}

export function stopJmsBandwidthScheduler(): void {
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  stopConfigSubscription?.()
  stopConfigSubscription = null
  if (activeJob) void speedtestCancel()
  activeJob = null
}

export function getLastJmsMetrics(): JmsMetricsSnapshot | null {
  return lastSnapshot
}
