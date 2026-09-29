import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { createServer, request, type Server } from 'http'
import { createServer as createHttpsServer, get as httpsGet } from 'https'
import { connect, type Socket } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { downloadSample } from './download'
import { drainTestConnections } from './cleanup'
import {
  disableTestEndpoint,
  enableTestEndpoint,
  getTestEndpoint,
  getTestEndpoints,
  injectSpeedtestConfig,
  type TestEndpoint
} from './runtime'

// Opt-in: no installed app, real subscriptions, system proxy, TUN or public network is touched.
const binary = process.env.MIHOMO_TEST_BINARY
const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url))

describe.skipIf(!binary)('real Mihomo isolated routing', () => {
  let processHandle: ChildProcess
  let directory: string
  let apiSocket: string
  let endpoint: TestEndpoint
  let source: string
  let logs = ''
  let requestsA = 0
  let requestsB = 0
  const servers: Server[] = []
  const sockets = new Set<Socket>()
  const listen = async (server: Server): Promise<number> => {
    servers.push(server)
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    return address.port
  }
  const api = (method: string, route: string, body?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: apiSocket,
          path: route,
          method,
          headers: { 'Content-Type': 'application/json' }
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            data += chunk
          })
          res.on('end', () => {
            if ((res.statusCode || 500) >= 300) reject(new Error(`${res.statusCode}: ${data}`))
            else resolve(data ? JSON.parse(data) : {})
          })
        }
      )
      req.setTimeout(1500, () => req.destroy(new Error('API timeout')))
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'clashb-speedtest-'))
    apiSocket = path.join(directory, 'api.sock')
    const target = await listen(
      createHttpsServer({ key, cert }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        const interval = setInterval(() => res.write(Buffer.alloc(8192)), 10)
        res.on('close', () => clearInterval(interval))
      })
    )
    source = `https://localhost:${target}/data`
    const proxy = (increment: () => void): Server => {
      const server = createServer()
      server.on('connect', (_req, client, head) => {
        increment()
        const upstream = connect(target, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          client.pipe(upstream).pipe(client)
        })
        sockets.add(upstream)
        client.on('close', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
      })
      return server
    }
    const portA = await listen(proxy(() => requestsA++))
    const portB = await listen(proxy(() => requestsB++))
    const dead = createServer()
    const deadPort = await listen(dead)
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    endpoint = await enableTestEndpoint()
    for (let slot = 1; slot < 6; slot++) await enableTestEndpoint(slot)
    const config = injectSpeedtestConfig({
      mode: 'rule',
      'log-level': 'debug',
      'external-controller-unix': apiSocket,
      'mixed-port': 0,
      'allow-lan': false,
      dns: { enable: false },
      hosts: { localhost: '127.0.0.1' },
      proxies: [
        { name: 'NodeA', type: 'http', server: '127.0.0.1', port: portA },
        { name: 'DeadNode', type: 'http', server: '127.0.0.1', port: deadPort }
      ],
      'proxy-providers': {
        providerB: {
          type: 'inline',
          payload: [{ name: 'NodeB', type: 'http', server: '127.0.0.1', port: portB }]
        }
      },
      'proxy-groups': [
        { name: 'Ordinary', type: 'select', proxies: ['NodeA'], use: ['providerB'] }
      ],
      rules: ['MATCH,DIRECT']
    })
    await writeFile(path.join(directory, 'config.yaml'), stringify(config))
    processHandle = spawn(binary as string, [
      '-d',
      directory,
      '-f',
      path.join(directory, 'config.yaml')
    ])
    processHandle.stdout?.on('data', (data) => {
      logs += data.toString()
    })
    processHandle.stderr?.on('data', (data) => {
      logs += data.toString()
    })
    processHandle.on('error', (error) => {
      logs += error.message
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      try {
        await api('GET', '/version')
        ready = true
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    if (!ready) throw new Error(`Mihomo failed to start:\n${logs}`)
    await api('PUT', '/proxies/Ordinary', { name: 'NodeB' })
  }, 15000)
  afterEach(async () => {
    if (!processHandle || processHandle.exitCode !== null) return
    await Promise.all(
      getTestEndpoints().map((entry) =>
        drainTestConnections(
          entry.name,
          {
            reset: async () => {
              await api('PUT', `/proxies/${entry.name}`, { name: 'REJECT' })
            },
            list: async () =>
              ((await api('GET', '/connections')).connections || []) as {
                id: string
                metadata: { inboundName: string }
              }[],
            close: async (id) => {
              await api('DELETE', `/connections/${encodeURIComponent(id)}`)
            }
          },
          AbortSignal.timeout(1500)
        )
      )
    )
  })
  afterAll(async () => {
    if (processHandle && processHandle.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => processHandle.kill('SIGKILL'), 1000)
        processHandle.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        processHandle.kill('SIGTERM')
      })
    }
    sockets.forEach((s) => s.destroy())
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    disableTestEndpoint()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('pins A and provider-only B separately despite ordinary selection and DIRECT rules', async () => {
    for (const [node, expectedA, expectedB] of [
      ['NodeA', 1, 0],
      ['NodeB', 1, 1]
    ] as const) {
      await api('PUT', `/proxies/${endpoint.name}`, { name: node })
      expect((await api('GET', `/proxies/${endpoint.name}`)).now).toBe(node)
      const sample = await downloadSample({
        endpoint,
        url: source,
        maxBytes: 16000,
        signal: AbortSignal.timeout(2000),
        ca: cert
      })
      expect(sample.reason, logs).toBe('limit')
      expect(requestsA).toBe(expectedA)
      expect(requestsB).toBe(expectedB)
      expect((await api('GET', '/proxies/Ordinary')).now).toBe('NodeB')
    }
  })
  it('a dead tested node fails even though direct access to the source works', async () => {
    await new Promise<void>((resolve, reject) => {
      const direct = httpsGet(source, { ca: cert }, (response) => {
        expect(response.statusCode).toBe(200)
        response.once('data', () => {
          response.destroy()
          resolve()
        })
      })
      direct.once('error', reject)
    })
    await api('PUT', `/proxies/${endpoint.name}`, { name: 'DeadNode' })
    const sample = await downloadSample({
      endpoint,
      url: source,
      maxBytes: 16000,
      signal: AbortSignal.timeout(2000),
      ca: cert
    })
    expect(sample.bytes, logs).toBe(0)
    expect(sample.reason).not.toBe('limit')
    expect(requestsA).toBe(1)
    expect(requestsB).toBe(1)
  })
  it('explicit listener routing overrides global/direct modes too', async () => {
    await api('PUT', `/proxies/${endpoint.name}`, { name: 'NodeA' })
    for (const mode of ['global', 'direct']) {
      await api('PATCH', '/configs', { mode })
      const before = requestsA
      const sample = await downloadSample({
        endpoint,
        url: source,
        maxBytes: 16000,
        signal: AbortSignal.timeout(2000),
        ca: cert
      })
      expect(sample.reason, logs).toBe('limit')
      expect(requestsA).toBeGreaterThanOrEqual(before + 1)
    }
  })
  it('pins six simultaneous downloads to six distinct listeners without cross-selection', async () => {
    const startA = requestsA
    const startB = requestsB
    const privateNames = new Set(getTestEndpoints().map((entry) => entry.name))
    let maxActive = 0
    const evidence = new Map<string, string[]>()
    let polling = false
    const poll = setInterval(() => {
      if (polling) return
      polling = true
      void api('GET', '/connections')
        .then((response) => {
          const connections = response.connections as {
            metadata: { inboundName: string }
            chains: string[]
          }[]
          const owned = (connections || []).filter((connection) =>
            privateNames.has(connection.metadata.inboundName)
          )
          maxActive = Math.max(maxActive, owned.length)
          owned.forEach((connection) =>
            evidence.set(connection.metadata.inboundName, connection.chains)
          )
        })
        .finally(() => {
          polling = false
        })
    }, 10)
    try {
      const samples = await Promise.all(
        Array.from({ length: 6 }, async (_, slot) => {
          const entry = getTestEndpoint(slot)
          if (!entry) throw new Error('Missing slot')
          const node = slot % 2 === 0 ? 'NodeA' : 'NodeB'
          await api('PUT', `/proxies/${entry.name}`, { name: node })
          return downloadSample({
            endpoint: entry,
            url: source,
            maxBytes: 128 * 1024,
            signal: AbortSignal.timeout(2000),
            ca: cert
          })
        })
      )
      expect(samples.every((sample) => sample.reason === 'limit')).toBe(true)
      expect(maxActive).toBe(6)
      // Mihomo may retry a dial internally; each observed chain, not attempt count, proves routing.
      expect(requestsA - startA).toBeGreaterThanOrEqual(3)
      expect(requestsB - startB).toBeGreaterThanOrEqual(3)
      for (let slot = 0; slot < 6; slot++) {
        const entry = getTestEndpoint(slot)
        if (!entry) throw new Error('Missing slot')
        expect(evidence.get(entry.name)).toEqual([slot % 2 === 0 ? 'NodeA' : 'NodeB', entry.name])
      }
      expect((await api('GET', '/proxies/Ordinary')).now).toBe('NodeB')
    } finally {
      clearInterval(poll)
    }
  })
})
