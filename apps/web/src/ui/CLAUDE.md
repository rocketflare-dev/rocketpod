# UI (React SPA)

A map of `apps/web/src/ui/`. The conventions every UI edit follows (tokens, data layer, realtime,
streaming, guards, bundle rules, tests, plugin UI) are `.claude/rules/ui.md`, loaded with this file.
Built to `dist/ui`, served in production by the Node server (`src/node/assets.ts`).

## Read before editing

- The run page, timeline, action panel, agent forms/outputs, `useAgents` / `useRunStream` /
  `useNavBadges` → `pages/agents/CLAUDE.md`
- Knowledge list, document viewer, search, `DocumentCard` / `DocumentLink`, `useDocuments` →
  `pages/documents/CLAUDE.md`
- The chat page or `useChat` / `useSendMessage` → `pages/chat/CLAUDE.md`
- A Settings tab (AI providers, prompts, agent models, usage, groups, people) →
  `pages/settings/CLAUDE.md`
- The Guide reader, `components/guide/`, `GuideLink`, `lib/guide*.ts` → `pages/guide/CLAUDE.md`
- `lib/` transports (api-client, websocket client, SSE, AG-UI streams) → `lib/CLAUDE.md`
- Anything a plugin contributes (`UiPlugin`, `src/plugins/<id>/ui/`) → `.claude/rules/ui.md` →
  Plugins, and `apps/web/src/plugins/CLAUDE.md` for the seam

## Shell

- `App.tsx` — providers `ErrorBoundary` → `QueryClientProvider` → `AuthProvider` →
  `AbilityProvider` → `WebSocketProvider` → `BrowserRouter` → routes; dev-only
  `ReactQueryDevtools` in a `Suspense`. The header `<WebSocketStatus />` dot and
  `<ConnectionBanner />` above the routed page. Route table in three tiers: public (`/login`,
  `/magic-link/sent`, `/magic-link/confirm`, `/invite/:token`), signed-in (`/cli/confirm`), signed-in-without-tenant
  (`/select-tenant`, `/pending`, `/no-access` — `ProtectedRoute requireTenant={false}`), and the
  shell (`/*` — `ProtectedRoute`, `Layout` mounted ONCE, nested `<Routes>` beneath it; a second
  `ErrorBoundary` wraps each `<main>`). Installed plugins' routes are mapped per tier inside the
  same `Suspense`.
- `index.css` — the design system: themes `rocketpod-light`/`rocketpod-dark`, semantic tokens
  (`--surface-*`, `--border-*`, `--text-*`, `--tone-*`), primitives (`.surface-panel`,
  `.data-table`, `.status-badge`, `.nav-item`), `@source` lines, safelist. Rebrand instructions are
  in its header comment.
- `components/` — the shell: `Layout` (slots `headerStart` = `OrgSwitcher`, `headerEnd` =
  `NotificationsBell` + `UserMenu`, `sidebarFooter`), `SideNav` (config-driven: `CORE_NAVIGATION`
  composed with plugin groups by `composeNav`, filtered by `filterNavConfig` on `guard` flags),
  `AuthCard` (public-page card), `PendingInvitationsBanner`, `RoleBadge`, `EnvironmentBadge`,
  `ThemeToggle`, `ErrorBoundary`. Guards: `ProtectedRoute` (session + tenant → `noTenantRoute`; a
  global admin with NO tenant is let through to `/admin/*` only — `isAdminPath`), `RequireGuard`
  (any `NavGuard`), `AdminRoute` / `GlobalAdminRoute` (sugar over it). `components/permissions/` —
  `AbilityProvider` (unpacks `session.permissions`), `IfCan` / `IfCannot`. Realtime:
  `WebSocketProvider`, `WebSocketStatus` (header dot), `ConnectionBanner` (after 5 s away from
  `open`). `components/shared/` — generic primitives (Toast, Modal, SectionPanel,
  PaginationControls, FieldError…) plus the visibility trio (`AccessPicker`, `AccessBadge`,
  `VisibilityModal`), `DocumentCard` / `DocumentLink` and `GuideLink`, all markdown-free — the eager
  barrel. `components/ai/` (`Markdown`, `ChatBubble`, `StatRows`, `FeedbackThumbs`) — lazy chunks
  only. `components/guide/` — `pages/guide/CLAUDE.md`.
- `hooks/` — `useAuth` (session, `status`, `selectTenant`, `logout`, `applySession`,
  `useTenancyMode`), `usePermissions` (`can/cannot/isOwnerLevel/isAdminLevel/isGlobalAdmin`),
  `useNavGuard` (the ONE place nav and route guards are decided), `useFeature` (in
  `useFeatureFlags.ts`), `useRealtimeTopic`, then one file per resource (`useMembers`,
  `useInvitations`, `useApiKeys`, `useNotifications`, `useTenant`, `useProfile`, `useActivity`,
  `useAccessRequests`, `useAdminAccessRequests`, `useAdminTenants`, `useAdminUsers`,
  `useAuthMethods`, plus the feature hooks the nested docs list) exporting `xQueryOptions()` +
  `useX()` + mutation hooks; `useAppInfo`, `useDebounce`, `useModalState`,
  `useLocalStoragePreference`, `useEnvironmentTitle`. `useProfile` also holds the avatar upload
  (`useUploadAvatar`, `validateAvatarFile`, `AVATAR_ACCEPT`).
- `lib/` — see `lib/CLAUDE.md`. `stores/websocketStore.ts` — the one zustand store.
- `pages/` — route-level components, lazy in `App.tsx` except Home/Login/NotFound. `admin/` is
  nested routes under `AdminLayout` (the `globalAdmin` guard). An installed plugin's pages are NOT
  here — they are `src/plugins/<id>/ui/pages/`. `public/` — static assets copied as-is.

## Routes and guards

| Route | Guard | Notes |
|---|---|---|
| `/chat/:conversationId?` | `read Conversation` | lazy, carries the markdown chunk |
| `/agents`, `/agents/runs/:runId` | `read AgentRun` | `RunPage` is its own lazy chunk |
| `/documents`, `/documents/:documentId`, `/search` | `read Document` | the viewer has no nav entry |
| `/guide` | none | the server answers each reader with their audience's pages |
| `/settings?tab=…` | `guard="admin"` | tabs gate further — `pages/settings/CLAUDE.md` |
| `/admin/*` | `globalAdmin` | reachable with no tenant |

The AI pages read the contracts in
`@rocketpod/shared/ai/{agents,embeddings,agent-models,interrupts,artifacts}`.

## Identity flow

- `useAuth` (`hooks/useAuth.tsx`) runs ONE query, `GET /auth/session` (zod-parsed); a 401
  resolves to `null` (logged out) so the query is never removed. Identity changes (`selectTenant`,
  invite accept, logout, global 401) go through `replaceSession()`: `setQueryData` on the session,
  then `resetQueries`/`removeQueries` on everything tenant-scoped. Never `queryClient.clear()`
  while observers are mounted.
- Global 401 (`notifyUnauthorized`): the handler only acts when a session WAS cached, drops it, and
  `navigateTo`s `/login?returnUrl=` unless already on a public path (D20). OAuth (a full-page
  redirect to `/auth/:provider?returnUrl=`), dev-login and logout are full-page (`hardNavigate`)
  so the cookie round-trips cleanly. `useAuth().logout` follows a `200 { endSessionUrl }` with
  `hardNavigate`, else lands on `/login?signedOut=1`.
- `Login.tsx`: `GET /auth/methods` drives the buttons; other methods are hidden, not disabled.
  Magic link is `POST /auth/magic-link/request`. With `methods.oidcOnly` it shows the one SSO
  button and never redirects to `/auth/oidc` on its own — signing in is always a click.
  `?as=<email>` (what `pnpm bootstrap` opens) calls `POST /auth/dev-login` once on mount, ONLY when
  `methods.devLogin` is true AND the email is in `DEV_ACCOUNTS` (the allow-list; an arbitrary
  address does nothing); never widen the allow-list.
- No active tenant → `noTenantRoute(session)`: access request → `/pending`; memberships →
  `/select-tenant`; `signupMode === 'approval'` → `/pending`; else `/no-access`. Exception: a
  global admin opens `/admin/*` with no membership (the bootstrap admin must be able to approve the
  first request), and `/pending` / `/no-access` show them an "Open the admin area" link. In that
  state `useNavGuard` allows ONLY `'globalAdmin'` guards (every tenant page hides, so nothing
  tenant-scoped is linked), `OrgSwitcher` reads "No organisation", `NotificationsBell` and the
  Profile / Notifications menu links render nothing, and `WebSocketProvider` never connects (it
  needs a tenant id).
- Single-tenant mode (`useTenancyMode()`, D25) hides `OrgSwitcher`, `/select-tenant` (redirects
  home), org create/delete and the slug field, the `new_org` approve branch, and collapses
  `/admin/tenants` to the one detail.
- `EnvironmentBadge` + `useEnvironmentTitle` read `APP_ENV`/`RELEASE_VERSION` from
  `/auth/session`; staging must look different from production.

## Feature flags admin

- `/admin/feature-flags` (`pages/admin/FeatureFlags.tsx` + `FlagOverrides.tsx`, lazy, the
  `globalAdmin` guard the whole `/admin` block already carries) separates the two layers visually:
  `availableInEnvironment` is config a redeploy moves, everything else is a click. Overrides offer
  three states — On / Off / Default — because deleting the row (follow the platform state) is a
  real third answer a checkbox cannot express; the section is absent in single mode, matching the
  routes. Gating rules for a flag: `.claude/rules/ui.md` → Guards.
- The `Example feature` nav item, its page and its notes CRUD are the `example-feature` PLUGIN,
  not core files: they live in `src/plugins/example-feature/ui/` and arrive through
  `UiPlugin.routes` / `UiPlugin.nav` (there is no `ExampleFeature` page under `pages/` and no
  `EXAMPLE_FEATURE` const in `lib/feature-guards.ts`). Delete the whole plugin (three directories,
  its barrel lines, its surface in `.rocketflare.json`) rather than editing the shell.
- Its nav test is `src/plugins/example-feature/tests/ui/feature-flag-nav.test.tsx` — it MOVED into
  the plugin with the nav item it looks for (a test that outlived its subject is a false failure).
  It drives the REAL `useNavGuard` — never a re-implementation, which is what hid the
  ability-wildcard bug — and runs every assertion for a global admin as well as an owner.
