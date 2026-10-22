/**
 * Subscribe this page to a realtime TOPIC (`@rocketpod/shared/realtime` § Topics) for as long as it
 * is mounted — one row's live progress, `tenantTopic('<id>.<kind>', tenantId, rowId)`. The hook
 * only declares interest: the events arrive through `WebSocketProvider`, which invalidates their
 * query roots like any other nudge, so no component reads the socket. `null` subscribes to nothing.
 */
import { useEffect } from 'react'
import { websocketClient } from '../lib/websocketClient'

export function useRealtimeTopic(topic: string | null): void {
  useEffect(() => {
    if (!topic) return
    return websocketClient.subscribe(topic)
  }, [topic])
}
