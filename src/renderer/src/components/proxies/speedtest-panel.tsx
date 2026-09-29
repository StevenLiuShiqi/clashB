import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner
} from '@heroui/react'
import { useEffect, useMemo, useState } from 'react'
import {
  speedtestCancel,
  speedtestSelectFastest,
  speedtestSnapshot,
  speedtestStart,
  speedtestTargets
} from '@renderer/utils/ipc'
import {
  DEFAULT_SPEEDTEST_URL,
  SPEEDTEST_LIMITS,
  type SpeedtestMode,
  type SpeedtestSnapshot,
  type SpeedtestStatus
} from '../../../../shared/speedtest'

const SOURCE_KEY = 'clashb-speedtest-source'
const labels: Record<SpeedtestStatus, string> = {
  pending: '未测试',
  running: '下载中',
  success: '有效',
  insufficient: '样本不足',
  failed: '失败',
  cancelled: '已取消'
}
const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
interface Props {
  group: string
  onClose: () => void
  onSelected: () => void
}

export default function SpeedtestPanel({ group, onClose, onSelected }: Props): React.JSX.Element {
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem(SOURCE_KEY) || DEFAULT_SPEEDTEST_URL
    } catch {
      return DEFAULT_SPEEDTEST_URL
    }
  })
  const [targets, setTargets] = useState<string[]>([])
  const [node, setNode] = useState('')
  const [mode, setMode] = useState<SpeedtestMode>('quick')
  const [snapshot, setSnapshot] = useState<SpeedtestSnapshot | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [sort, setSort] = useState(true)
  const active = snapshot !== null && snapshot.phase !== 'finished'
  const busy = active || working
  const current = snapshot?.group === group ? snapshot : null
  const currentQuick = current?.mode === 'quick'
  const quick = mode === 'quick'

  useEffect(() => {
    let alive = true
    const unsubscribe = window.electron.ipcRenderer.on('speedtestUpdated', (_event, value) => {
      if (alive) setSnapshot(value as SpeedtestSnapshot)
    })
    void speedtestSnapshot()
      .then((state) => {
        if (alive) setSnapshot(state)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    let alive = true
    setLoading(true)
    setNode('')
    void speedtestTargets(group)
      .then((items) => {
        if (alive) {
          setTargets(items)
          setError('')
        }
      })
      .catch((e) => {
        if (alive) {
          setTargets([])
          setError(String(e))
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [group])
  const results = useMemo(() => {
    const list = [...(current?.results || [])]
    return sort
      ? list.sort((a, b) => {
          if (a.status === 'success' && b.status !== 'success') return -1
          if (b.status === 'success' && a.status !== 'success') return 1
          return current?.mode !== 'quick' && a.status === 'success' && b.status === 'success'
            ? b.bytesPerSecond - a.bytesPerSecond
            : 0
        })
      : list
  }, [current, sort])
  const action = async (fn: () => Promise<void>): Promise<void> => {
    setWorking(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError(String(e))
    } finally {
      setWorking(false)
    }
  }
  const count = node ? 1 : targets.length
  const plannedBytes = Math.min(
    count * (quick ? SPEEDTEST_LIMITS.quickNodeBytes : SPEEDTEST_LIMITS.nodeBytes),
    SPEEDTEST_LIMITS.batchBytes
  )
  return (
    <Modal isOpen size="4xl" scrollBehavior="inside" onClose={onClose}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span>实际下载测速 · {group}</span>
          <span className="text-xs font-normal text-foreground-500">
            不改日常线路 · 六路快速检查 / 逐个详细测速 · 首次准备需额外重载时间
          </span>
        </ModalHeader>
        <ModalBody>
          <div className="rounded-lg bg-warning-50 p-3 text-sm text-warning-700">
            {quick
              ? '最多 6 个节点同时检查，每个节点 2 秒内完成 3 MiB 下载即达标。所有节点都保留结果，不在第一个达标时停止。并行共享带宽，未达标不代表不能看视频，可单独复查。'
              : '逐个详细测速，每节点最多 5 秒 / 20 MiB。结果只代表到此测速源的下载表现，不代表综合最佳线路。'}
            整批最多 3 分钟 / 200
            MiB，实际订阅消耗可能略高。测速会占用带宽，不保证持续播放或平台可访问。
          </div>
          <label className="flex flex-col gap-1 text-sm">
            检查模式
            <select
              aria-label="检查模式"
              className="rounded-lg bg-default-100 p-2 text-foreground"
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value as SpeedtestMode)}
            >
              <option value="quick">快速检查：最多 6 个同时测（默认）</option>
              <option value="detailed">详细测速：逐个测，比较速度</option>
            </select>
          </label>
          <Input
            label="统一 HTTPS 测速地址"
            value={url}
            onValueChange={setUrl}
            isDisabled={busy}
            description="同批固定地址，不跟随重定向；需要返回未压缩的二进制或纯文本下载内容。"
          />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              测试范围
              <select
                aria-label="测试范围"
                className="rounded-lg bg-default-100 p-2 text-foreground"
                value={node}
                disabled={busy || loading}
                onChange={(e) => setNode(e.target.value)}
              >
                <option value="">本组全部实际节点（{targets.length}）</option>
                {targets.map((target) => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
            </label>
            <Button
              color="primary"
              isDisabled={busy || loading || targets.length === 0}
              onPress={() =>
                void action(async () => {
                  const state = await speedtestStart({ group, node: node || undefined, url, mode })
                  setSnapshot(state)
                  try {
                    localStorage.setItem(SOURCE_KEY, url)
                  } catch {
                    /* Storage is optional. */
                  }
                })
              }
            >
              {quick ? '开始快速检查' : '开始下载测速'}
            </Button>
            <Button
              color="danger"
              variant="flat"
              isDisabled={!active}
              onPress={() => void action(speedtestCancel)}
            >
              取消测速
            </Button>
          </div>
          <p className="text-xs text-foreground-500">
            本次 {count} 个节点，最多接收约 {mib(plannedBytes)} MiB。
            {quick
              ? '六个节点仅需一轮检查；超过六个自动分批。2 秒是每节点的检查时限，准备和清理另需少量时间。'
              : '不足 0.5 秒或 1 MiB 的样本不参与排名。'}
            达到整批预算就停止，不保证测完超大组。
          </p>
          {loading && <Spinner label="读取实际节点…" size="sm" />}
          {active && !current && (
            <p role="status">正在测试其他代理组：{snapshot?.group}。请等待或取消。</p>
          )}
          {error && (
            <p role="alert" className="text-danger break-all">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-success">
              {notice}
            </p>
          )}
          {current && (
            <>
              <div
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
                aria-live="polite"
              >
                <span>
                  {current.phase === 'preparing'
                    ? '正在准备专用测速通道…'
                    : `${current.results.filter((r) => r.status !== 'pending' && r.status !== 'running').length} / ${current.results.length} 已结束 · 已接收 ${mib(current.bytes)} MiB`}
                </span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sort}
                    onChange={(e) => setSort(e.target.checked)}
                  />
                  {currentQuick ? '达标节点优先（不按速度排名）' : '按有效下载速度降序'}
                </label>
              </div>
              <p className={current.valid ? 'text-sm text-foreground-500' : 'text-sm text-warning'}>
                {current.message}
              </p>
              <p className="break-all text-xs text-foreground-500">
                本轮模式：{currentQuick ? '六路快速检查' : '逐个详细测速'} · 测速源：{current.url}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-default-200">
                      <th className="p-2">节点</th>
                      <th>{currentQuick ? '检查耗时（含建连）' : '下载速度'}</th>
                      <th>数据 / 下载时长</th>
                      <th>状态 / 测试时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result) => (
                      <tr key={result.node} className="border-b border-default-100">
                        <td className="max-w-64 break-words p-2">{result.node}</td>
                        <td className="whitespace-nowrap pr-3">
                          {currentQuick
                            ? result.elapsedMs === undefined
                              ? '—'
                              : `${(result.elapsedMs / 1000).toFixed(2)} s`
                            : result.bodyMs > 0
                              ? `${mib(result.status === 'running' ? (result.bytes * 1000) / result.bodyMs : result.bytesPerSecond)} MiB/s`
                              : '—'}
                        </td>
                        <td className="whitespace-nowrap pr-3">
                          {mib(result.bytes)} MiB / {(result.bodyMs / 1000).toFixed(2)} s
                        </td>
                        <td className="py-2">
                          <span>
                            {currentQuick && result.status === 'success'
                              ? '达标'
                              : currentQuick && result.status === 'insufficient'
                                ? '未快速达标'
                                : labels[result.status]}
                            {result.testedAt
                              ? ` · ${new Date(result.testedAt).toLocaleTimeString()}`
                              : ''}
                          </span>
                          <div className="text-xs text-foreground-500 break-words">
                            {result.message}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            关闭（任务继续）
          </Button>
          <Button
            color="primary"
            isDisabled={busy || !current?.valid || !results.some((r) => r.status === 'success')}
            onPress={() =>
              void action(async () => {
                if (!current) return
                const selected = await speedtestSelectFastest(current.id)
                setNotice(`已在 ${current.group} 选择 ${selected}`)
                onSelected()
              })
            }
          >
            {currentQuick ? '选择达标线路' : '切换到本轮已测最快'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
