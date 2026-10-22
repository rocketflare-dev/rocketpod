/**
 * Realtime bridge (D8, 06 §b): connects the singleton `websocketClient` once `useAuth()` is
 * authenticated AND has a tenant, reconnects when the tenant changes, disconnects on sign-out.
 * Every event becomes query invalidations through `invalidationsFor` (`@rocketpod/shared/realtime`) —
 * the client re-queries, it never applies a payload as state; a `notification.created` refreshes
 * the bell, and is never a toast (toasts are for problems, `components/shared/Toast.tsx`).
 * Components subscribe to query state, never to the socket.
 */
import { invalidationsFor } from '@rocketpod/shared/realtime'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useAuth } from '@/ui/hooks/useAuth'
import { websocketClient } from '@/ui/lib/websocketClient'

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { status, tenant } = useAuth()
  const queryClient = useQueryClient()
  const tenantId = status === 'authenticated' ? (tenant?.id ?? null) : null

  useEffect(() => {
    if (!tenantId) {
      websocketClient.disconnect()
      return
    }
    websocketClient.connect(tenantId)
    // Sign-out / tenant loss disconnects via the branch above; a tenant switch reconnects in place.
  }, [tenantId])

  useEffect(
    () =>
      websocketClient.onEvent(event => {
        for (const queryKey of invalidationsFor(event)) {
          void queryClient.invalidateQueries({ queryKey })
        }
      }),
    [queryClient]
  )

  return <>{children}</>
}
