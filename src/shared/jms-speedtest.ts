export const JMS_AUTO_PING_GROUP = 'JMS Auto Ping'
export const JMS_AUTO_BANDWIDTH_GROUP = 'JMS Auto Bandwidth'

export type JmsCheckIntervalMinutes = 0 | 5 | 10 | 30 | 60

export interface JmsNodeMetric {
  node: string
  ping: number
  bandwidthMbps: number
  status: 'success' | 'insufficient' | 'failed' | 'cancelled'
  testedAt: number
}

export interface JmsMetricsSnapshot {
  sourceGroup: string
  metrics: JmsNodeMetric[]
  updatedAt: number
  error?: string
  subscriptionError?: { status?: number; likelyExpired: boolean; message: string }
}
