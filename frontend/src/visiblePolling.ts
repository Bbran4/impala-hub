// Poll only while visible. A request already in flight may finish after hiding.
export function startVisiblePolling(
  load: (initial: boolean) => Promise<unknown>,
  intervalMs: number | undefined,
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
  clock: Pick<Window, 'setInterval' | 'clearInterval'> = window,
) {
  let stopped = false
  let running = false
  let initial = true
  let timer: number | undefined
  const refresh = async () => {
    if (stopped || running || page.visibilityState !== 'visible') return
    running = true
    const first = initial
    initial = false
    try { await load(first) }
    catch (error) { console.error('Background refresh failed', error) }
    finally { running = false }
  }
  const visibilityChanged = () => {
    if (timer !== undefined) clock.clearInterval(timer)
    timer = undefined
    if (stopped || page.visibilityState !== 'visible') return
    void refresh()
    if (intervalMs !== undefined) timer = clock.setInterval(() => { void refresh() }, intervalMs)
  }
  page.addEventListener('visibilitychange', visibilityChanged)
  visibilityChanged()
  return () => {
    stopped = true
    if (timer !== undefined) clock.clearInterval(timer)
    page.removeEventListener('visibilitychange', visibilityChanged)
  }
}
