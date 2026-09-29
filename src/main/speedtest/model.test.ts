import { describe, expect, it } from 'vitest'
import { assembleGraph, expandNodes, manualPath, validateSource, sampleStatus } from './model'

const graph = {
  Root: { name: 'Root', type: 'Selector', all: ['A', 'Nested', 'DIRECT'] },
  Nested: { name: 'Nested', type: 'Selector', all: ['B', 'A', 'Root'] },
  A: { name: 'A', type: 'Shadowsocks' },
  B: { name: 'B', type: 'Vmess' },
  DIRECT: { name: 'DIRECT', type: 'Direct' }
}

describe('speed-test policy', () => {
  it('expands nested groups once, skips direct and terminates cycles', () => {
    expect(expandNodes(graph, 'Root')).toEqual(['A', 'B'])
  })
  it('finds only manual paths and never traverses automatic groups', () => {
    expect(manualPath(graph, 'Root', 'B')).toEqual([
      { group: 'Nested', node: 'B' },
      { group: 'Root', node: 'Nested' }
    ])
    expect(
      manualPath({ ...graph, Nested: { ...graph.Nested, type: 'URLTest' } }, 'Root', 'B')
    ).toBeNull()
  })
  it('requires HTTPS public source without credentials, fragment or local addresses', () => {
    for (const url of [
      'http://example.com/file',
      'https://localhost/file',
      'https://127.0.0.1',
      'https://[::1]',
      'https://user:pass@example.com',
      'https://example.com/#x'
    ]) {
      expect(() => validateSource(url)).toThrow()
    }
    expect(validateSource('https://speed.cloudflare.com/__down?bytes=20971520')).toContain('__down')
  })
  it('never ranks failures, cancellation or insufficient data', () => {
    expect(sampleStatus(2 * 1024 * 1024, 1000, 'deadline')).toBe('success')
    expect(sampleStatus(20 * 1024 * 1024, 80, 'limit')).toBe('insufficient')
    expect(sampleStatus(100, 2000, 'end')).toBe('insufficient')
    expect(sampleStatus(2 * 1024 * 1024, 1000, 'cancelled')).toBe('cancelled')
    expect(sampleStatus(2 * 1024 * 1024, 1000, 'error')).toBe('failed')
  })
})

describe('provider identity', () => {
  it('resolves provider-only leaves and does not expose the private selector', () => {
    const result = assembleGraph(
      {
        Root: { name: 'Root', type: 'Selector', all: ['B', 'private'] },
        private: { name: 'private', type: 'Selector', all: ['B'] }
      },
      { provider: { proxies: [{ name: 'B', type: 'Vmess', id: 'b' }] } },
      'private'
    )
    expect(expandNodes(result, 'Root')).toEqual(['B'])
    expect(result.private).toBeUndefined()
    expect(result.Root.all).toEqual(['B'])
  })
  it('rejects ambiguous names across providers or inline proxies', () => {
    const node = { name: 'A', type: 'Vmess', id: 'a' }
    expect(() => assembleGraph({}, { one: { proxies: [node] }, two: { proxies: [node] } })).toThrow(
      '同名'
    )
    expect(() =>
      assembleGraph({ A: { ...node, id: 'different' } }, { one: { proxies: [node] } })
    ).toThrow('歧义')
  })
  it('ignores the compatible provider that mirrors regular proxies', () => {
    expect(() =>
      assembleGraph(
        { A: { name: 'A', type: 'Http', id: 'a' } },
        { default: { vehicleType: 'Compatible', proxies: [{ name: 'A', type: 'Http', id: 'a' }] } }
      )
    ).not.toThrow()
  })
})

it('excludes every private slot from the graph and GLOBAL membership', () => {
  const graph = assembleGraph(
    {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['A', 'slot0', 'slot1'] },
      A: { name: 'A', type: 'Http' },
      slot0: { name: 'slot0', type: 'Selector', all: ['A'] },
      slot1: { name: 'slot1', type: 'Selector', all: ['A'] }
    },
    {},
    ['slot0', 'slot1']
  )
  expect(graph.GLOBAL.all).toEqual(['A'])
  expect(Object.keys(graph).sort()).toEqual(['A', 'GLOBAL'])
})
