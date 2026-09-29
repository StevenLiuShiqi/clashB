import { getAxios, mihomoHotReloadConfig } from '../core/mihomoApi'
import { mainWindow } from '../window'
import {
  SPEEDTEST_LIMITS,
  type SpeedtestSnapshot,
  type SpeedtestStart
} from '../../shared/speedtest'
import { SpeedtestController } from './controller'
import { downloadSample } from './download'
import { drainTestConnections } from './cleanup'
import { assembleGraph, expandNodes, type ProxyGraph, type ProxyNode } from './model'
import {
  disableTestEndpoint,
  enableTestEndpoint,
  getTestEndpoint,
  getTestEndpoints,
  onSpeedtestInvalidated
} from './runtime'

let initializing = false
async function graph(signal: AbortSignal): Promise<ProxyGraph> {
  const api = await getAxios()
  const response = (await api.get('/proxies', { signal })) as unknown as { proxies: ProxyGraph }
  const providers = (await api.get('/providers/proxies', { signal })) as unknown as {
    providers: Record<string, { proxies?: ProxyNode[]; vehicleType?: string }>
  }
  return assembleGraph(
    response.proxies,
    providers.providers,
    getTestEndpoints().map((endpoint) => endpoint.name)
  )
}
async function select(group: string, node: string, signal: AbortSignal): Promise<void> {
  const api = await getAxios()
  await api.put(`/proxies/${encodeURIComponent(group)}`, { name: node }, { signal })
  const selected = (await api.get(`/proxies/${encodeURIComponent(group)}`, {
    signal
  })) as unknown as ProxyNode
  if (selected.now !== node) throw new Error('内核未确认选点，已阻止测速或切换')
}

const controller = new SpeedtestController({
  prepare: async (signal, mode) => {
    const count = mode === 'quick' ? SPEEDTEST_LIMITS.quickConcurrency : 1
    for (let slot = 0; slot < count; slot++) {
      signal.throwIfAborted()
      await enableTestEndpoint(slot)
    }
    const endpoints = getTestEndpoints().slice(0, count)
    signal.throwIfAborted()
    const api = await getAxios()
    let ready = false
    try {
      const response = (await api.get('/proxies', { signal })) as unknown as { proxies: ProxyGraph }
      ready = endpoints.every((endpoint) => response.proxies[endpoint.name]?.type === 'Selector')
    } catch {
      signal.throwIfAborted()
    }
    if (!ready) {
      // This single intentional reload precedes sampling. Other lifecycle changes invalidate results.
      initializing = true
      try {
        await mihomoHotReloadConfig()
      } catch (error) {
        disableTestEndpoint()
        try {
          await mihomoHotReloadConfig()
        } catch {
          /* Keep the original activation error. */
        }
        throw error
      } finally {
        initializing = false
      }
    }
    signal.throwIfAborted()
    await Promise.all(endpoints.map((endpoint) => select(endpoint.name, 'REJECT', signal)))
  },
  graph,
  selectTestNode: async (node, signal, slot) => {
    const endpoint = getTestEndpoint(slot)
    if (!endpoint) throw new Error('测速入口未启用')
    const api = await getAxios()
    const selector = (await api.get(`/proxies/${encodeURIComponent(endpoint.name)}`, {
      signal
    })) as unknown as ProxyNode
    if (!selector.all?.includes(node)) throw new Error('节点不在测速入口的可选列表中，已阻止下载')
    await select(endpoint.name, node, signal)
  },
  download: (url, maxBytes, signal, onProgress, slot) => {
    const endpoint = getTestEndpoint(slot)
    if (!endpoint) throw new Error('测速入口不可用')
    return downloadSample({ endpoint, url, maxBytes, signal, onProgress })
  },
  select,
  cleanup: async (slot) => {
    const endpoint = getTestEndpoint(slot)
    if (!endpoint) return
    const api = await getAxios()
    const signal = AbortSignal.timeout(1500)
    await drainTestConnections(
      endpoint.name,
      {
        reset: () => select(endpoint.name, 'REJECT', signal),
        list: async () => {
          const response = (await api.get('/connections', {
            signal
          })) as unknown as IMihomoConnectionsInfo
          return response.connections || []
        },
        close: async (id) => {
          await api.delete(`/connections/${encodeURIComponent(id)}`, { signal })
        }
      },
      signal
    )
  },
  publish: (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('speedtestUpdated', snapshot)
  }
})
onSpeedtestInvalidated((reason) => {
  if (!initializing) controller.invalidate(reason)
})

export async function speedtestStart(input: SpeedtestStart): Promise<SpeedtestSnapshot> {
  return controller.start(input)
}
export async function speedtestCancel(): Promise<void> {
  controller.cancel()
}
export async function speedtestSnapshot(): Promise<SpeedtestSnapshot | null> {
  return controller.snapshot()
}
export async function speedtestSelectFastest(id: string): Promise<string> {
  if (typeof id !== 'string') throw new Error('测速批次无效')
  return controller.selectFastest(id)
}
export async function speedtestTargets(group: string): Promise<string[]> {
  if (typeof group !== 'string' || group.length > 1024) throw new Error('代理组无效')
  return expandNodes(await graph(AbortSignal.timeout(10000)), group)
}
