/** `GET /auth/methods`: which sign-in methods the server has configured — drives Login. */
import { authMethodsSchema } from '@rocketpod/shared/auth'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function authMethodsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth.methods,
    queryFn: () => api.get('/auth/methods', { schema: authMethodsSchema }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useAuthMethods() {
  return useQuery(authMethodsQueryOptions())
}

/**
 * Under IdP-managed tenancy, where organisations come from: the identity provider named by its
 * configured button text (`OIDC_LABEL`), never a hard-coded product name.
 */
export function useIdpOrganisationsHint(): string {
  const { data } = useAuthMethods()
  const source = data?.oidc?.label ?? 'your identity provider'
  return `Organisations come from ${source}. Ask an administrator there for access.`
}
