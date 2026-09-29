import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'http'
import { Agent, request as httpsRequest } from 'https'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import type { Socket } from 'net'
import type { TestEndpoint } from './runtime'

export interface Sample {
  bytes: number
  bodyMs: number
  reason: 'end' | 'limit' | 'deadline' | 'cancelled' | 'error' | 'source-error'
  message?: string
}
interface DownloadOptions {
  endpoint: TestEndpoint
  url: string
  maxBytes: number
  signal: AbortSignal
  onProgress?: (bytes: number, bodyMs: number) => void
  // For the local TLS test fixture only. Never accepted over IPC.
  ca?: Buffer
}

/** No system proxy, direct fallback, redirect, decompression, or pooled connections. */
export function downloadSample(options: DownloadOptions): Promise<Sample> {
  return new Promise((resolve) => {
    let finished = false
    let bytes = 0
    let bodyStarted: number | undefined
    let tunnel: ClientRequest | undefined
    let request: ClientRequest | undefined
    let socket: Socket | undefined
    let tls: TLSSocket | undefined
    let response: IncomingMessage | undefined
    const agent = new Agent({ keepAlive: false, maxSockets: 1 })
    const elapsed = (): number => (bodyStarted === undefined ? 0 : performance.now() - bodyStarted)
    const finish = (reason: Sample['reason'], message?: string): void => {
      if (finished) return
      finished = true
      const bodyMs = elapsed()
      options.signal.removeEventListener('abort', abort)
      const owned = [...new Set([socket, tls, tunnel?.socket].filter((s): s is Socket => !!s))]
      const closed = owned.map(
        (s) =>
          new Promise<void>((done) => {
            if (s.closed) done()
            else s.once('close', () => done())
          })
      )
      response?.destroy()
      request?.destroy()
      tls?.destroy()
      socket?.destroy()
      tunnel?.destroy()
      agent.destroy()
      void Promise.all(closed).then(() => resolve({ bytes, bodyMs, reason, message }))
    }
    const abort = (): void =>
      finish(
        options.signal.reason?.message === 'deadline' ? 'deadline' : 'cancelled',
        options.signal.reason?.message === 'deadline' ? '达到时间上限' : '已取消'
      )
    const fail = (error: Error): void => finish('error', error.message)
    if (options.signal.aborted) {
      abort()
      return
    }
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      finish('limit')
      return
    }
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      const url = new URL(options.url)
      if (url.protocol !== 'https:') throw new Error('仅支持 HTTPS 测速源')
      const authority = `${url.hostname}:${url.port || '443'}`
      tunnel = httpRequest({
        hostname: '127.0.0.1',
        port: options.endpoint.port,
        method: 'CONNECT',
        path: authority,
        agent: false,
        headers: {
          Host: authority,
          'Proxy-Authorization': `Basic ${Buffer.from(`${options.endpoint.username}:${options.endpoint.password}`).toString('base64')}`
        }
      })
      tunnel.on('error', fail)
      tunnel.on('response', (res) => {
        res.destroy()
        finish('error', `测速代理拒绝 CONNECT (${res.statusCode})`)
      })
      tunnel.on('connect', (res, connected, head) => {
        socket = connected
        socket.on('error', fail)
        if (finished) {
          socket.destroy()
          return
        }
        if (res.statusCode !== 200 || head.length) {
          finish('error', `测速代理 CONNECT 失败 (${res.statusCode})`)
          return
        }
        // The hostname is sent to the core in CONNECT; Node never resolves/dials the target.
        agent.createConnection = () => {
          tls = tlsConnect({
            socket: connected,
            servername: url.hostname,
            rejectUnauthorized: true,
            ca: options.ca
          })
          tls.on('error', fail)
          return tls
        }
        request = httpsRequest(
          url,
          {
            method: 'GET',
            agent,
            headers: {
              'Accept-Encoding': 'identity',
              'Cache-Control': 'no-cache, no-store',
              Pragma: 'no-cache',
              Connection: 'close',
              Range: `bytes=0-${Math.floor(options.maxBytes) - 1}`
            }
          },
          (res) => {
            response = res
            if (finished) {
              res.destroy()
              return
            }
            const encoding = res.headers['content-encoding']
            const type = res.headers['content-type']?.split(';')[0].trim().toLowerCase()
            if (
              (res.statusCode !== 200 && res.statusCode !== 206) ||
              (encoding && encoding !== 'identity') ||
              !type ||
              ![
                'application/octet-stream',
                'application/binary',
                'binary/octet-stream',
                'text/plain'
              ].includes(type)
            ) {
              finish(
                'source-error',
                `测速源响应不适用 (${res.statusCode}, ${type || '未知类型'})，请换源后重新测速`
              )
              return
            }
            bodyStarted = performance.now()
            res.on('data', (chunk: Buffer) => {
              if (finished) return
              // Account for the whole received chunk; never hide overshoot from the batch budget.
              bytes += chunk.length
              options.onProgress?.(bytes, elapsed())
              if (bytes >= options.maxBytes) finish('limit', '达到测试数据上限')
            })
            res.on('end', () => finish('end'))
            res.on('aborted', () => finish('error', '测速源提前断开连接'))
            res.on('error', fail)
          }
        )
        request.on('error', fail)
        request.end()
      })
      tunnel.end()
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
