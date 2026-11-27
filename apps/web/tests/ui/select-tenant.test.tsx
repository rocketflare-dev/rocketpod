/**
 * `/select-tenant` offers "Create organisation" only when the session's `canCreateTenant` says the
 * server would allow it — never under IdP-managed tenancy or while access is pending, including
 * through the `?create=1` deep link the org switcher uses.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NoAccess from '@/ui/pages/NoAccess'
import SelectTenant from '@/ui/pages/SelectTenant'
import {
  makeSession,
  makeTenant,
  renderWithProviders,
  stubFetch,
} from './helpers/renderWithProviders'

describe('SelectTenant and creating an organisation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('offers to create one when the server allows it', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, { session: makeSession(), route: '/select-tenant' })
    expect(screen.getByRole('button', { name: /Create organisation/ })).toBeInTheDocument()
  })

  it('lists memberships without the create button when the server would refuse it', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, {
      session: makeSession({ canCreateTenant: false, tenants: [makeTenant()] }),
      route: '/select-tenant',
    })
    expect(screen.getByText('Choose an organisation')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create organisation/ })).not.toBeInTheDocument()
  })

  it('?create=1 does not open the form when creation is refused', () => {
    stubFetch()
    renderWithProviders(<SelectTenant />, {
      session: makeSession({ canCreateTenant: false, tenant: null, tenants: [] }),
      route: '/select-tenant?create=1',
    })
    expect(screen.queryByLabelText(/Organisation name|Name/)).not.toBeInTheDocument()
    expect(screen.getByText('Ask an administrator to add you to one.')).toBeInTheDocument()
  })

  it('under IdP-managed tenancy there is no form, and the empty list names the identity provider', async () => {
    stubFetch({
      '/auth/methods': {
        magicLink: false,
        providers: [],
        devLogin: false,
        oidc: { label: 'Corp SSO' },
      },
    })
    renderWithProviders(<SelectTenant />, {
      // The hook gates on the flag even if the server's canCreateTenant said otherwise.
      session: makeSession({ idpManagedTenancy: true, tenant: null, tenants: [] }),
      route: '/select-tenant?create=1',
    })
    expect(await screen.findByText(/Organisations come from Corp SSO/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create organisation/ })).not.toBeInTheDocument()
  })
})

describe('NoAccess under IdP-managed tenancy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('says organisations come from the identity provider instead of asking for an invitation', async () => {
    stubFetch({
      '/auth/methods': {
        magicLink: false,
        providers: [],
        devLogin: false,
        oidc: { label: 'Corp SSO' },
      },
    })
    renderWithProviders(<NoAccess />, {
      session: makeSession({ idpManagedTenancy: true, tenant: null, tenants: [] }),
      route: '/no-access',
    })
    expect(await screen.findByText(/Organisations come from Corp SSO/)).toBeInTheDocument()
    expect(screen.queryByText(/Access is by invitation/)).not.toBeInTheDocument()
  })
})
