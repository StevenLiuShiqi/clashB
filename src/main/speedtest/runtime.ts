import { randomBytes, randomUUID } from 'crypto'
import { createServer } from 'net'
import { SPEEDTEST_LIMITS } from '../../shared/speedtest'
import { JMS_AUTO_BANDWIDTH_GROUP, JMS_AUTO_PING_GROUP } from '../../shared/jms-speedtest'

export interface TestEndpoint {
  name: string
  port: number
  username: string
  password: string
}
const endpoints: TestEndpoint[] = []
const listeners = new Set<(reason: string) => void>()

export function invalidateSpeedtest(reason = '配置或内核已变化，请重新测速'): void {
  listeners.forEach((listener) => listener(reason))
}
export function onSpeedtestInvalidated(listener: (reason: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function disableTestEndpoint(): void {
  endpoints.length = 0
}
export function getTestEndpoint(slot = 0): TestEndpoint | undefined {
  return endpoints[slot]
}
export function getTestEndpoints(): TestEndpoint[] {
  return [...endpoints]
}

export async function enableTestEndpoint(slot = 0): Promise<TestEndpoint> {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SPEEDTEST_LIMITS.quickConcurrency)
    throw new Error('测速通道编号无效')
  if (endpoints[slot]) return endpoints[slot]
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配测速端口'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
  if (endpoints.some((entry) => entry.port === port)) return enableTestEndpoint(slot)
  const endpoint = {
    name: `__clashb_speedtest_${randomUUID()}`,
    port,
    username: 'speedtest',
    password: randomBytes(32).toString('hex')
  }
  endpoints[slot] = endpoint
  return endpoint
}

export function injectJmsDerivedGroups<T extends object>(config: T): T {
  const source = config as Record<string, unknown>
  const groups = Array.isArray(source['proxy-groups']) ? source['proxy-groups'] : []
  const jms = groups.find(
    (group) =>
      group && typeof group === 'object' && (group as Record<string, unknown>).name === 'JMS'
  ) as Record<string, unknown> | undefined
  if (!jms || jms.type !== 'select' || !Array.isArray(jms.proxies)) return config
  const jmsProxies = [...jms.proxies]
  const existingPing = groups.find(
    (group) =>
      group &&
      typeof group === 'object' &&
      (group as Record<string, unknown>).type === 'url-test' &&
      Array.isArray((group as Record<string, unknown>).proxies) &&
      ((group as Record<string, unknown>).proxies as unknown[]).every((name) =>
        jmsProxies.includes(name)
      )
  ) as Record<string, unknown> | undefined
  const ping = {
    ...(existingPing ?? {}),
    name: JMS_AUTO_PING_GROUP,
    type: 'url-test',
    proxies: jmsProxies
  }
  const bandwidth = { name: JMS_AUTO_BANDWIDTH_GROUP, type: 'select', proxies: jmsProxies }
  const filtered = groups.filter((group) => {
    if (!group || typeof group !== 'object') return true
    const name = (group as Record<string, unknown>).name
    return name !== JMS_AUTO_PING_GROUP && name !== JMS_AUTO_BANDWIDTH_GROUP && name !== 'JMS Auto'
  })
  return { ...config, 'proxy-groups': [...filtered, ping, bandwidth] }
}

// Inject into the core-only copy. Never persist credentials or this group to a subscription/export.
export function injectSpeedtestConfig<T extends object>(config: T): T {
  if (!endpoints.length) return config
  const source = config as Record<string, unknown>
  const groups = Array.isArray(source['proxy-groups']) ? source['proxy-groups'] : []
  const inbound = Array.isArray(source.listeners) ? source.listeners : []
  const proxies = Array.isArray(source.proxies) ? source.proxies : []
  const names = proxies.flatMap((proxy) =>
    proxy &&
    typeof proxy.name === 'string' &&
    !['direct', 'reject', 'pass', 'dns'].includes(proxy.type)
      ? [proxy.name]
      : []
  )
  const providers = source['proxy-providers']
  const use = providers && typeof providers === 'object' ? Object.keys(providers) : []
  return {
    ...config,
    'proxy-groups': [
      ...groups,
      ...endpoints.map((endpoint) => ({
        name: endpoint.name,
        type: 'select',
        hidden: true,
        proxies: ['REJECT', ...names],
        use
      }))
    ],
    listeners: [
      ...inbound,
      ...endpoints.map((endpoint) => ({
        name: endpoint.name,
        type: 'http',
        listen: '127.0.0.1',
        port: endpoint.port,
        proxy: endpoint.name,
        users: [{ username: endpoint.username, password: endpoint.password }]
      }))
    ]
  }
}
