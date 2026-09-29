import { describe, expect, it } from 'vitest'
import { injectJmsDerivedGroups } from './runtime'

describe('JMS runtime groups', () => {
  it('creates ping and bandwidth groups from the JMS source without mutating input', () => {
    const source = {
      'proxy-groups': [
        { name: 'JMS', type: 'select', proxies: ['A', 'B'] },
        { name: 'JMS Auto', type: 'url-test', proxies: ['A', 'B'], url: 'https://example.test' },
        { name: 'Other', type: 'select', proxies: ['C'] }
      ]
    }
    const result = injectJmsDerivedGroups(source)
    expect(source['proxy-groups']).toHaveLength(3)
    expect(result['proxy-groups']).toEqual(
      expect.arrayContaining([
        source['proxy-groups'][0],
        source['proxy-groups'][2],
        expect.objectContaining({
          name: 'JMS Auto Ping',
          type: 'url-test',
          proxies: ['A', 'B'],
          url: 'https://example.test'
        }),
        { name: 'JMS Auto Bandwidth', type: 'select', proxies: ['A', 'B'] },
        { name: 'JMS Auto', type: 'select', hidden: true, proxies: ['JMS Auto Ping'] }
      ])
    )
  })

  it('does not create derived groups for a non-selector or missing JMS group', () => {
    const missing = { 'proxy-groups': [{ name: 'Other', type: 'select', proxies: ['A'] }] }
    expect(injectJmsDerivedGroups(missing)).toBe(missing)
    const wrongType = { 'proxy-groups': [{ name: 'JMS', type: 'url-test', proxies: ['A'] }] }
    expect(injectJmsDerivedGroups(wrongType)).toBe(wrongType)
  })
})

it('migrates a nested legacy JMS Auto group and rewrites all references', () => {
  const result = injectJmsDerivedGroups({
    'proxy-groups': [
      { name: 'JMS', type: 'select', proxies: ['JMS Auto', 'A', 'B'] },
      { name: 'JMS Auto', type: 'url-test', proxies: ['A', 'B'], url: 'https://example.test' },
      { name: 'JMS Auto Bandwidth', type: 'select', proxies: ['JMS Auto'] }
    ]
  })
  const groups = result['proxy-groups']
  expect(groups).toEqual(
    expect.arrayContaining([
      { name: 'JMS', type: 'select', proxies: ['JMS Auto Ping', 'A', 'B'] },
      expect.objectContaining({ name: 'JMS Auto Ping', type: 'url-test', proxies: ['A', 'B'] }),
      { name: 'JMS Auto Bandwidth', type: 'select', proxies: ['A', 'B'] }
    ])
  )
  expect(groups).toEqual(
    expect.arrayContaining([
      { name: 'JMS Auto', type: 'select', hidden: true, proxies: ['JMS Auto Ping'] }
    ])
  )
})
