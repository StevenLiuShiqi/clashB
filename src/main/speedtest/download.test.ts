import { readFileSync } from 'fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { connect, type Socket } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadSample } from './download'

const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url))
const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url))
const servers: HttpServer[] = []
const sockets = new Set<Socket>()
async function listen(server: HttpServer): Promise<number> {
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
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}
afterEach(async () => {
  sockets.forEach((s) => s.destroy())
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})
async function fixture(
  status = 200,
  encoding?: string,
  truncate = false
): Promise<{ port: number; url: string; connects: () => number }> {
  const target = await listen(
    createHttpsServer({ key, cert }, (_req, res) => {
      res.writeHead(status, {
        'content-type': 'application/octet-stream',
        ...(encoding ? { 'content-encoding': encoding } : {}),
        ...(truncate ? { 'content-length': '1000000' } : {})
      })
      if (status !== 200) {
        res.end('error')
        return
      }
      if (truncate) {
        res.end(Buffer.alloc(8192))
        return
      }
      const timer = setInterval(() => res.write(Buffer.alloc(8192)), 10)
      res.on('close', () => clearInterval(timer))
    })
  )
  let count = 0
  const proxy = createHttpServer()
  proxy.on('connect', (req, client, head) => {
    count++
    if (
      req.headers['proxy-authorization'] !==
      `Basic ${Buffer.from('user:secret').toString('base64')}`
    ) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const upstream = connect(target, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    sockets.add(upstream)
    client.on('close', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return {
    port: await listen(proxy),
    url: `https://localhost:${target}/data`,
    connects: () => count
  }
}
const endpoint = (port: number) => ({ name: 'test', port, username: 'user', password: 'secret' })

describe('explicit CONNECT downloader', () => {
  it('caps streamed bytes and uses a new authenticated tunnel for each sample', async () => {
    const f = await fixture()
    for (let i = 0; i < 2; i++) {
      const sample = await downloadSample({
        endpoint: endpoint(f.port),
        url: f.url,
        maxBytes: 16000,
        signal: AbortSignal.timeout(1000),
        ca: cert
      })
      expect(sample.reason).toBe('limit')
      expect(sample.bytes).toBeGreaterThanOrEqual(16000)
      expect(sample.bytes).toBeLessThan(16000 + 16384)
    }
    expect(f.connects()).toBe(2)
  })
  it('does not directly download a reachable target when proxy authentication fails', async () => {
    const f = await fixture()
    const sample = await downloadSample({
      endpoint: { ...endpoint(f.port), password: 'wrong' },
      url: f.url,
      maxBytes: 16000,
      signal: AbortSignal.timeout(1000),
      ca: cert
    })
    expect(sample.reason).toBe('error')
    expect(sample.bytes).toBe(0)
    expect(sample.message).toContain('407')
  })
  it('rejects redirection instead of following it', async () => {
    const f = await fixture(302)
    const sample = await downloadSample({
      endpoint: endpoint(f.port),
      url: f.url,
      maxBytes: 16000,
      signal: AbortSignal.timeout(1000),
      ca: cert
    })
    expect(sample.reason).toBe('source-error')
    expect(sample.bytes).toBe(0)
  })
  it('cancels an established stream promptly', async () => {
    const f = await fixture()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('cancelled')), 80)
    const sample = await downloadSample({
      endpoint: endpoint(f.port),
      url: f.url,
      maxBytes: 2000000,
      signal: controller.signal,
      ca: cert
    })
    clearTimeout(timer)
    expect(sample.reason).toBe('cancelled')
    expect(sample.bytes).toBeLessThan(2000000)
  })
  it('does not open a connection for an already cancelled request', async () => {
    const f = await fixture()
    const sample = await downloadSample({
      endpoint: endpoint(f.port),
      url: f.url,
      maxBytes: 16000,
      signal: AbortSignal.abort(),
      ca: cert
    })
    expect(sample.reason).toBe('cancelled')
    expect(f.connects()).toBe(0)
  })
  it('rejects compressed responses and truncated bodies', async () => {
    const compressed = await fixture(200, 'gzip')
    const first = await downloadSample({
      endpoint: endpoint(compressed.port),
      url: compressed.url,
      maxBytes: 16000,
      signal: AbortSignal.timeout(1000),
      ca: cert
    })
    expect(first.reason).toBe('source-error')
    const truncated = await fixture(200, undefined, true)
    const second = await downloadSample({
      endpoint: endpoint(truncated.port),
      url: truncated.url,
      maxBytes: 16000,
      signal: AbortSignal.timeout(1000),
      ca: cert
    })
    expect(second.reason).toBe('error')
  })
  it('keeps TLS verification enabled', async () => {
    const f = await fixture()
    const sample = await downloadSample({
      endpoint: endpoint(f.port),
      url: f.url,
      maxBytes: 16000,
      signal: AbortSignal.timeout(1000)
    })
    expect(sample.reason).toBe('error')
    expect(sample.bytes).toBe(0)
  })
  it('cancels even when the proxy never answers CONNECT', async () => {
    const proxy = createHttpServer()
    proxy.on('connect', (_req, socket) => {
      sockets.add(socket)
    })
    const port = await listen(proxy)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('deadline')), 30)
    const sample = await downloadSample({
      endpoint: endpoint(port),
      url: 'https://example.com/data',
      maxBytes: 16000,
      signal: controller.signal
    })
    clearTimeout(timer)
    expect(sample.reason).toBe('deadline')
    expect(sample.bytes).toBe(0)
  })
})
