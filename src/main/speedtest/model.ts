import { isIP } from 'net'
import type { SpeedtestStatus } from '../../shared/speedtest'

export interface ProxyNode {
  name: string
  type: string
  all?: string[]
  now?: string
  id?: string
  'dialer-proxy'?: string
  'provider-name'?: string
}
export type ProxyGraph = Record<string, ProxyNode>
export interface Selection {
  group: string
  node: string
}

const specialTypes = new Set([
  'direct',
  'reject',
  'rejectdrop',
  'pass',
  'compatible',
  'dns',
  'passrule',
  'rematch'
])
export function isTestable(node: ProxyNode): boolean {
  return !node.all && !specialTypes.has(node.type.toLowerCase())
}

export function expandNodes(graph: ProxyGraph, root: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const node = graph[name]
    if (!node) return
    if (node.all) node.all.forEach(visit)
    else if (isTestable(node)) result.push(name)
  }
  visit(root)
  return result
}

// Bottom-up selection keeps the parent on its existing path until its child is ready.
export function manualPath(graph: ProxyGraph, root: string, target: string): Selection[] | null {
  const visit = (name: string, seen: Set<string>): Selection[] | null => {
    if (seen.has(name)) return null
    const node = graph[name]
    if (!node?.all || node.type !== 'Selector') return null
    const next = new Set([...seen, name])
    if (node.all.includes(target) && graph[target] && isTestable(graph[target])) {
      return [{ group: name, node: target }]
    }
    for (const child of node.all) {
      const path = visit(child, next)
      if (path) return [...path, { group: name, node: child }]
    }
    return null
  }
  return visit(root, new Set())
}

export function validateSource(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('测速地址无效')
  const url = new URL(input)
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(host.replace(/^\[|\]$/g, '')) ||
    !host.includes('.') ||
    host.endsWith('.') ||
    ['.localhost', '.local', '.internal', '.lan', '.home', '.test', '.invalid'].some((s) =>
      host.endsWith(s)
    )
  )
    throw new Error('请使用公开 HTTPS 下载地址（443 端口，无凭据、IP 或片段）')
  return url.toString()
}

export function sampleStatus(bytes: number, ms: number, reason: string): SpeedtestStatus {
  if (reason === 'cancelled') return 'cancelled'
  if (reason === 'error') return 'failed'
  return bytes >= 1024 * 1024 && ms >= 500 ? 'success' : 'insufficient'
}

export function graphFingerprint(graph: ProxyGraph): string {
  return JSON.stringify(
    Object.keys(graph)
      .sort()
      .map((name) => {
        const node = graph[name]
        return [name, node.type, node.id, node.all, node['dialer-proxy'], node['provider-name']]
      })
  )
}

export function assembleGraph(
  proxies: ProxyGraph,
  providers: Record<string, { proxies?: ProxyNode[]; vehicleType?: string }>,
  internal?: string | string[]
): ProxyGraph {
  const result: ProxyGraph = Object.assign(Object.create(null) as ProxyGraph, proxies)
  const owners = new Map<string, string>()
  for (const [provider, value] of Object.entries(providers)) {
    if (value.vehicleType === 'Compatible') continue
    for (const node of value.proxies || []) {
      const owner = owners.get(node.name)
      if (owner && owner !== provider)
        throw new Error(`不同订阅存在同名节点 ${node.name}，请先重命名`)
      const existing = result[node.name]
      if (existing && (existing.all || (existing.id && node.id && existing.id !== node.id))) {
        throw new Error(`存在歧义节点 ${node.name}，无法安全测速`)
      }
      owners.set(node.name, provider)
      result[node.name] = { ...node, 'provider-name': provider }
    }
  }
  if (internal) {
    const privateNames = new Set(Array.isArray(internal) ? internal : [internal])
    for (const name of privateNames) delete result[name]
    for (const [name, node] of Object.entries(result)) {
      if (node.all)
        result[name] = { ...node, all: node.all.filter((entry) => !privateNames.has(entry)) }
    }
  }
  return result
}
