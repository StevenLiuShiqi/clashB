import { afterEach, describe, expect, it } from 'vitest'
import {
  disableTestEndpoint,
  enableTestEndpoint,
  injectSpeedtestConfig,
  invalidateSpeedtest,
  onSpeedtestInvalidated
} from './runtime'

afterEach(() => disableTestEndpoint())
describe('core-only configuration', () => {
  it('does not add a listener before explicit activation', () => {
    const original = { mode: 'rule' }
    expect(injectSpeedtestConfig(original)).toBe(original)
  })
  it('adds an authenticated loopback route without mutating the subscription', async () => {
    const endpoint = await enableTestEndpoint()
    const original = {
      proxies: [{ name: 'A', type: 'http' }],
      'proxy-providers': { subscription: {} },
      'proxy-groups': [{ name: 'Normal', type: 'select', proxies: ['A'] }],
      listeners: [{ name: 'existing', type: 'http', port: 9000 }]
    }
    const before = JSON.stringify(original)
    const result = injectSpeedtestConfig(original)
    expect(JSON.stringify(original)).toBe(before)
    expect(result.listeners).toHaveLength(2)
    expect(result.listeners[1]).toMatchObject({
      name: endpoint.name,
      listen: '127.0.0.1',
      proxy: endpoint.name,
      users: [{ username: endpoint.username, password: endpoint.password }]
    })
    expect(result['proxy-groups'][1]).toMatchObject({
      hidden: true,
      proxies: ['REJECT', 'A'],
      use: ['subscription']
    })
    expect(await enableTestEndpoint()).toEqual(endpoint)
  })
  it('publishes invalidation and supports subscription cleanup', () => {
    const messages: string[] = []
    const off = onSpeedtestInvalidated((reason) => messages.push(reason))
    invalidateSpeedtest('changed')
    off()
    invalidateSpeedtest('ignored')
    expect(messages).toEqual(['changed'])
  })
})

describe('parallel slot isolation', () => {
  it('creates six different authenticated ports and selectors without changing the source', async () => {
    const slots = []
    for (let slot = 0; slot < 6; slot++) slots.push(await enableTestEndpoint(slot))
    expect(new Set(slots.map((slot) => slot.port)).size).toBe(6)
    expect(new Set(slots.map((slot) => slot.name)).size).toBe(6)
    expect(new Set(slots.map((slot) => slot.password)).size).toBe(6)
    const source = { proxies: [{ name: 'A', type: 'http' }], listeners: [] }
    const result = injectSpeedtestConfig(source)
    expect(source.listeners).toHaveLength(0)
    expect(result.listeners).toHaveLength(6)
    for (let slot = 0; slot < 6; slot++) {
      expect(result.listeners[slot]).toMatchObject({
        proxy: slots[slot].name,
        port: slots[slot].port,
        listen: '127.0.0.1'
      })
    }
  })
})
