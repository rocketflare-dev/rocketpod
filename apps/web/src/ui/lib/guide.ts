/**
 * The Guide's reads (`/api/guide/toc`, `/api/guide/page`) as query options. Static content: it
 * never goes stale within a tab, so nothing refetches it on focus or on a timer.
 */

import {
  type GuidePageResponse,
  type GuideTocResponse,
  guidePageResponseSchema,
  guideTocResponseSchema,
} from '@rocketpod/shared/guide'
import { queryOptions } from '@tanstack/react-query'
import { api } from './api-client'
import { queryKeys } from './query-keys'

export function guideTocQueryOptions() {
  return queryOptions<GuideTocResponse>({
    queryKey: queryKeys.guide.toc,
    queryFn: () => api.get('/api/guide/toc', { schema: guideTocResponseSchema }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function guidePageQueryOptions(path: string) {
  return queryOptions<GuidePageResponse>({
    queryKey: queryKeys.guide.page(path),
    queryFn: () =>
      api.get(`/api/guide/page?path=${encodeURIComponent(path)}`, {
        schema: guidePageResponseSchema,
      }),
    enabled: Boolean(path),
    staleTime: Number.POSITIVE_INFINITY,
  })
}
