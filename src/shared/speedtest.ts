export const SPEEDTEST_LIMITS = {
  nodeMs: 5000,
  nodeBytes: 20 * 1024 * 1024,
  quickNodeMs: 2000,
  quickNodeBytes: 3 * 1024 * 1024,
  quickConcurrency: 6,
  batchMs: 180000,
  batchBytes: 200 * 1024 * 1024
} as const

export const DEFAULT_SPEEDTEST_URL = 'https://speed.cloudflare.com/__down?bytes=20971520'

export type SpeedtestMode = 'quick' | 'detailed'

export type SpeedtestStatus =
  'pending' | 'running' | 'success' | 'insufficient' | 'failed' | 'cancelled'

export interface SpeedtestResult {
  node: string
  status: SpeedtestStatus
  bytes: number
  bodyMs: number
  elapsedMs?: number
  bytesPerSecond: number
  message?: string
  testedAt?: number
}

export interface SpeedtestSnapshot {
  mode: SpeedtestMode
  id: string
  group: string
  url: string
  phase: 'preparing' | 'running' | 'finished'
  startedAt: number
  results: SpeedtestResult[]
  bytes: number
  valid: boolean
  message?: string
}

export interface SpeedtestStart {
  mode?: SpeedtestMode
  group: string
  node?: string
  url: string
}
