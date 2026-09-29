interface TestConnection {
  id: string
  metadata: { inboundName?: string; specialProxy?: string }
}
interface ConnectionControl {
  reset: () => Promise<void>
  list: () => Promise<TestConnection[]>
  close: (id: string) => Promise<void>
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 40)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Core deletion/late dial completion is asynchronous; one empty snapshot is not an acknowledgement. */
export async function drainTestConnections(
  name: string,
  control: ConnectionControl,
  signal: AbortSignal
): Promise<void> {
  const started = performance.now()
  let emptySince: number | undefined
  signal.throwIfAborted()
  await control.reset()
  while (true) {
    signal.throwIfAborted()
    const owned = (await control.list()).filter(
      (connection) =>
        connection.metadata.inboundName === name || connection.metadata.specialProxy === name
    )
    const now = performance.now()
    if (owned.length) {
      emptySince = undefined
      await Promise.all(owned.map((connection) => control.close(connection.id)))
    } else {
      emptySince ??= now
      if (now - emptySince >= 200 && now - started >= 300) return
    }
    await pause(signal)
  }
}
