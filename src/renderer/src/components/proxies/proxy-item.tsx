import { Button, Card, CardBody } from '@heroui/react'
import { mihomoUnfixedProxy } from '@renderer/utils/ipc'
import React, { useMemo, useState, useCallback } from 'react'
import { FaMapPin } from 'react-icons/fa6'
import { useTranslation } from 'react-i18next'
import { KeyedMutator } from 'swr'
import type { SpeedtestResult } from '../../../../shared/speedtest'

interface Props {
  mutateProxies: KeyedMutator<IMihomoMixedGroup[]>
  onProxyDelay: (proxy: IMihomoProxy | IMihomoGroup, url?: string) => Promise<IMihomoDelay>
  proxyDisplayMode: 'simple' | 'full'
  proxy: IMihomoProxy | IMihomoGroup
  group: IMihomoMixedGroup
  onSelect: (group: string, proxy: string) => void
  selected: boolean
  isGroupTesting?: boolean
  speedtestResult?: SpeedtestResult
  speedtestPing?: number
}

function delayColor(delay: number): 'primary' | 'success' | 'warning' | 'danger' {
  if (delay === -1) return 'primary'
  if (delay === 0) return 'danger'
  if (delay < 500) return 'success'
  return 'warning'
}

const ProxyItemBase: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const {
    mutateProxies,
    proxyDisplayMode,
    group,
    proxy,
    selected,
    onSelect,
    onProxyDelay,
    isGroupTesting = false,
    speedtestResult,
    speedtestPing
  } = props

  const delay = useMemo(() => {
    if (speedtestPing !== undefined && speedtestPing > 0) return speedtestPing
    if (proxy.history.length > 0) {
      return proxy.history[proxy.history.length - 1].delay
    }
    return -1
  }, [proxy.history, speedtestPing])

  const [loading, setLoading] = useState(false)

  const isLoading = loading || isGroupTesting

  const speedtestText = useMemo(() => {
    if (!speedtestResult) return null
    if (speedtestResult.status === 'pending') return '待测'
    if (speedtestResult.status === 'running') return '测速中…'
    if (speedtestResult.status === 'success') return '≥12.6 Mbps'
    if (speedtestResult.bytesPerSecond > 0) {
      return `${((speedtestResult.bytesPerSecond * 8) / 1000000).toFixed(1)} Mbps`
    }
    if (speedtestResult.status === 'failed') return '测速失败'
    if (speedtestResult.status === 'cancelled') return '已取消'
    return '未达标'
  }, [speedtestResult])

  const delayText = useMemo(() => {
    if (delay === -1) return t('proxies.delay.test')
    if (delay === 0) return t('proxies.delay.timeout')
    return delay.toString()
  }, [delay, t])

  const onDelay = useCallback((): void => {
    setLoading(true)
    onProxyDelay(proxy, group.testUrl).finally(() => {
      mutateProxies()
      setLoading(false)
    })
  }, [proxy, group.testUrl, onProxyDelay, mutateProxies])

  const fixed = useMemo(() => group.fixed && group.fixed === proxy.name, [group.fixed, proxy.name])

  return (
    <Card
      as="div"
      onPress={() => onSelect(group.name, proxy.name)}
      isPressable
      fullWidth
      shadow="sm"
      className={`${
        fixed
          ? 'bg-secondary/30 border-r-2 border-r-secondary border-l-2 border-l-secondary'
          : selected
            ? 'bg-primary/30 border-r-2 border-r-primary border-l-2 border-l-primary'
            : 'bg-content2'
      }`}
      radius="sm"
    >
      <CardBody className="p-1">
        {proxyDisplayMode === 'full' ? (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center pl-1">
              <div className="text-ellipsis overflow-hidden whitespace-nowrap">
                <div className="flag-emoji inline" title={proxy.name}>
                  {proxy.name}
                </div>
              </div>
              {fixed && (
                <Button
                  isIconOnly
                  title={t('proxies.unpin')}
                  color="danger"
                  onPress={async () => {
                    await mihomoUnfixedProxy(group.name)
                    mutateProxies()
                  }}
                  variant="light"
                  className="h-5 p-0 text-sm"
                >
                  <FaMapPin className="text-md le" />
                </Button>
              )}
            </div>
            <div className="flex justify-between items-center pl-1">
              <div className="flex gap-1 items-center">
                <div className="text-foreground-400 text-xs bg-default-100 px-1 rounded-md">
                  {proxy.type}
                </div>
                {['tfo', 'udp', 'xudp', 'mptcp', 'smux'].map(
                  (protocol) =>
                    proxy[protocol as keyof IMihomoProxy] && (
                      <div
                        key={protocol}
                        className="text-foreground-400 text-xs bg-default-100 px-1 rounded-md"
                      >
                        {protocol}
                      </div>
                    )
                )}
              </div>
              <Button
                isIconOnly
                title={proxy.type}
                isLoading={isLoading}
                color={delayColor(delay)}
                onPress={onDelay}
                variant="light"
                className="h-full text-sm ml-auto -mt-0.5 px-2 relative w-min whitespace-nowrap"
              >
                <div className="w-full h-full flex items-center justify-end gap-1">
                  <span>{delayText}</span>
                  {speedtestText && <span className="text-xs text-primary">{speedtestText}</span>}
                </div>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-between items-center pl-1">
            <div className="text-ellipsis overflow-hidden whitespace-nowrap">
              <div className="flag-emoji inline" title={proxy.name}>
                {proxy.name}
              </div>
            </div>
            <div className="flex justify-end">
              {fixed && (
                <Button
                  isIconOnly
                  title={t('proxies.unpin')}
                  color="danger"
                  onPress={async () => {
                    await mihomoUnfixedProxy(group.name)
                    mutateProxies()
                  }}
                  variant="light"
                  className="h-5 p-0 text-sm"
                >
                  <FaMapPin className="text-md le" />
                </Button>
              )}
              <Button
                isIconOnly
                title={proxy.type}
                isLoading={isLoading}
                color={delayColor(delay)}
                onPress={onDelay}
                variant="light"
                className="h-full text-sm px-2 relative w-min whitespace-nowrap"
              >
                <div className="w-full h-full flex items-center justify-end gap-1">
                  <span>{delayText}</span>
                  {speedtestText && <span className="text-xs text-primary">{speedtestText}</span>}
                </div>
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

const ProxyItem = React.memo(ProxyItemBase, (prevProps, nextProps) => {
  // 必要时重新渲染
  return (
    prevProps.proxy.name === nextProps.proxy.name &&
    prevProps.proxy.history === nextProps.proxy.history &&
    prevProps.selected === nextProps.selected &&
    prevProps.proxyDisplayMode === nextProps.proxyDisplayMode &&
    prevProps.group.fixed === nextProps.group.fixed &&
    prevProps.isGroupTesting === nextProps.isGroupTesting &&
    prevProps.speedtestResult === nextProps.speedtestResult &&
    prevProps.speedtestPing === nextProps.speedtestPing
  )
})

ProxyItem.displayName = 'ProxyItem'

export default ProxyItem
