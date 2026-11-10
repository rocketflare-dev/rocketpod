---
paths:
  - apps/web/src/ui/**
  - apps/web/vite.config.ts
  - apps/web/postcss.config.js
---

# UI Patterns

React 19 + Vite, DaisyUI 5 on Tailwind v4, React Router 7, TanStack Query 5, zustand only for the
websocket store. Served from `dist/ui` by the same Node server as the API (SPA fallback).
Dev: Vite on :3000 proxies `/api`, `/auth`, `/ws` — plus every prefix an installed plugin declares
(the analytics plugin's `/cubejs-api` and `/mcp`, added by hand on install) — to the Node server on
:3001. Either port moves with `DEV_UI_PORT` / `DEV_API_PORT` (`scripts/lib/dev-ports.mjs`, shell or
`.env`); `DEV_ALLOWED_HOSTS` adds hostnames Vite answers for. Map, providers, identity flow:
`apps/web/src/ui/CLAUDE.md`.

## Design tokens, not raw colours

- Themes are two `@plugin "daisyui/theme"` blocks in `apps/web/src/shared/theme-tokens.css`
  (`rocketpod-light` default, `rocketpod-dark` prefersdark), imported by `ui/index.css` and by any
  public-site stylesheet. Its brand variables are the ONLY place a hex appears (rebrand steps: the
  header comment in `ui/index.css`). Components use DaisyUI
  semantic classes (`bg-base-200`, `text-primary`, `badge-warning`) or the kit's surface/border/
  text tokens (`--surface-panel`, `--border-subtle`, `.text-muted`, `.surface-panel`); **never
  `bg-blue-50`-style palette utilities**
- `apps/web/tests/ui/contrast.test.ts` gates the emitted tokens (WCAG AA: text 4.5:1, controls and
  focus ring 3:1); if you change a colour, run it
- `ThemeToggle` sets `data-theme` on `<html>`; the DOM attribute is the state, mirrored to
  `localStorage['theme']` and validated on read (`public/assets/theme-init.js`, the pre-hydration
  script — a file, because the shell's CSP refuses inline script; it also sets zod's `jitless`)
- Tailwind v4 content scanning: `index.css` starts with `@import "tailwindcss" source(none)` and
  then explicit `@source "./index.html"` / `@source "./**/*.{ts,tsx}"` — scoped to
  `apps/web/src/ui`. **Lesson**: without `source(none)` v4 auto-detects sources from the package
  root and scans the whole repo — docs, API code, tests, migrations — and DaisyUI emits a component
  for every stray word that looks like a class (`card`, `table`, `menu` in a comment). Keep the
  scan scoped. A dependency that ships pre-built JSX **and uncompiled Tailwind classes** is an
  explicit `@source` line pointing at its dist. Never `@source` node_modules without measuring the
  output first. Safelist (`@source inline(...)`) only classes built from props (`alert-*`,
  `btn-*`), never from data or from a dependency. Plugin pages: Plugins below
- Heroicons only (`@heroicons/react`; provider marks in `components/icons` are `currentColor`);
  `<details>/<summary>` dropdowns; `<dialog>` `Modal` (column layout, `max-h-[85vh]`: the BODY
  scrolls, title and actions stay — never let a modal grow past the viewport). No new UI library
  without a stated reason in the PR

## Data layer

- Imports: `@/ui/...` and `@rocketpod/shared/...` (never a relative path into `packages/`); never
  import from `src/api`, `src/db` or `src/permissions` — the ability MATRIX is server code, the UI
  only unpacks rules
- All HTTP via `lib/api-client.ts` (`api.get/post/put/patch/delete/upload`): `credentials:
  'include'`, typed `ApiError` from the shared envelope, a `schema` option that zod-parses the
  response with the same `@rocketpod/shared/<module>` schema the server validates with. No
  `hono/client` RPC (D13)
- Server data lives ONLY in the query cache: `useQuery` + a key from `query-keys.ts` + a
  `@rocketpod/shared` zod `schema` on `api.get`. One hook file per resource in
  `hooks/use<Resource>.ts`, exporting `queryOptions()` factories (for anything used by more than
  one component) + `useX()` + mutation hooks; keys from the central `queryKeys` factory in
  `lib/query-keys.ts` — never inline key arrays. `lib/queryClient.ts` holds the module-level client
  and its global `QueryCache.onError` (401 → `notifyUnauthorized`, `lib/CLAUDE.md`)
- Mutations live in the resource hook and invalidate via `queryKeys`; write methods toast errors by
  default (`showToast`). **Toasts are for problems only — never toast a success**: `ToastType` is
  `'error' | 'warning'` and the screen already shows the result. The one exception is
  `showUndoToast(msg, action)`, where the toast IS the undo for a change that can be taken back (a
  step move)
- **Polling rules** (Phase 3b): poll only while the server still owes an answer, with the decision
  as a pure function on the cached row — `refetchInterval: q => runPollInterval(q.state.data?.status)`
  (`RUN_POLL_MS` 3 s while **`runOwesAnswer`**, which is `queued || running` and deliberately NOT
  `isRunActive` — that includes `awaiting_input`, and a run parked on a person would otherwise be
  re-fetched every three seconds for the length of `AGENT_INTERRUPT_TIMEOUT`, by every open tab;
  lists poll while any listed row owes an answer); documents 5 s (`DOCUMENT_POLL_MS`) while a row
  is `pending`. Polling is the belt to the nudge's braces — a resource that has a server nudge
  still polls (the socket may be down); a resource without one (documents) polls only. Never poll a
  settled row, never poll unconditionally, never fight `refetchInterval` with timers in tests
- Pagination meta is `{ page, pageSize, total, totalPages }`; every list renders
  `PaginationControls` (it hides itself at one page). Forms: controlled inputs validated with the
  `@rocketpod/shared` schema the server uses; `FieldError` per field
- Files (D23): `api.upload('/api/files?scope=…', formData, { schema: uploadResponseSchema })` posts
  multipart **without** a JSON `Content-Type` (the browser sets the boundary). Check
  `isAvatarMimeType` / `MAX_UPLOAD_BYTES` from `@rocketpod/shared/files` client-side first
  (`validateAvatarFile` in `hooks/useProfile.ts`) so the server's 413/415 are a backstop, not the
  UX; `useUploadAvatar()` → `POST /api/files?scope=avatars` then invalidates `me` + `auth` and
  refreshes the session. Render `<img src={user.avatarUrl}>` with an `onError` fallback to
  initials — the object is tenant-scoped, the URL is not

## State

TanStack Query owns server state — do not add a store for server data. zustand owns UI state only:
the websocket connection state (`stores/websocketStore.ts`, written only by
`lib/websocketClient.ts` — fields in `lib/CLAUDE.md`), toasts, tab-lifetime flags.
Component-local UI state is `useState`; theme and density are DOM attributes.

## Realtime (D8) — DB is the truth, the WebSocket is a nudge

- Realtime events never become state: `components/WebSocketProvider.tsx` (after
  `AbilityProvider`) connects the `lib/websocketClient.ts` singleton (`/ws` on the Node server,
  fed by Postgres LISTEN/NOTIFY) once `useAuth()` is authenticated with a tenant, reconnects on
  tenant switch, disconnects on sign-out, and uses `useQueryClient()` to
  `invalidateQueries({ queryKey })` per root from `invalidationsFor(event)`; the hooks re-fetch.
  `notification.created` refreshes the bell and is never a toast
- The event type → query-key root map is **`REALTIME_INVALIDATIONS` / `invalidationsFor()` in
  `@rocketpod/shared/realtime`** (`packages/shared/src/realtime.ts`), not in the UI — a new server
  event type adds its roots there, never in a component, and `tests/ui/websocket-provider.test.tsx`
  asserts every root is a real `queryKeys` family
- **Convention: the `entity` string of an `entity.changed { entity, id }` nudge IS the query-key
  family root** — `invalidationsFor()` returns `[[entity]]`, so a resource whose server nudges
  `entity: 'agent-run'` names its family `['agent-run']` (`queryKeys.agentRuns.all`) and gets live
  refresh with zero hook-side socket code. When you add a resource: pick the root first, use the
  same string in the service's nudge and in `query-keys.ts`, and never subscribe to the socket from
  a hook
- Components subscribe to query state, never to the socket — the one exception is DECLARING
  interest in a realtime TOPIC (`useRealtimeTopic(topic | null)` while mounted, reference-counted in
  `websocketClient.subscribe` and resent on every reconnect), whose events still arrive through the
  provider's invalidation. `WebSocketStatus` (header dot) and `ConnectionBanner` (after 5 s
  degraded) read the store only. Tests inject a fake socket with `websocketClient.setFactory()` —
  reset it in `afterEach`

## Streaming (AG-UI over SSE, D17)

- SSE is consumed with **`fetch`, never `EventSource`** (GET-only, cannot carry the CSRF header),
  through `lib/sse.ts`, never `api-client`'s `request()` (JSON only). Transports, socket client,
  frame order: `lib/CLAUDE.md`
- **Spec AG-UI frames carry no `event:` line**; the type is inside the JSON, so nothing may key on
  the SSE event field. A new event is an AG-UI type added to `kitAguiEventSchema`, or a member of
  the kit's CUSTOM namespace, in `@rocketpod/shared/ai/agui` first — an APP adds its own CUSTOM
  events under its own prefix, never `kit.`
- **A read-stream that carries DURABLE rows writes them into the cache; only chat's in-flight text
  is local state** (`apps/web/src/ui/pages/chat/CLAUDE.md`). `useRunStream` is the ONLY writer of
  `['agent-run-agui', id]`, and that key must stay out of `REALTIME_INVALIDATIONS` — a nudge that
  invalidated it would wipe a live timeline with the very message telling it to refresh. Merge
  purely (the timeline model is idempotent under duplicated events), never append blindly
- **A read-stream closing with no terminal event means RECONNECT, not error** — redeploy, idle cap,
  duration cap, transport error, abort all look the same, deliberately. That is the inverse of the
  chat write-stream, where the stream IS the run and a failure is a `RUN_ERROR`

## Guards

- One guard primitive, `RequireGuard` (`components/RequireGuard.tsx`), decided in ONE place,
  `useNavGuard` (`AdminRoute` / `GlobalAdminRoute` are sugar). Coarse guards are role flags
  (`'admin'` = owner/admin/support/globalAdmin, `'globalAdmin'`); fine gates are abilities
  (`{ action, subject }`, `<IfCan action="manage" subject="Tenant">` / `<IfCannot>` from
  `components/permissions/`). Owner-ONLY actions (delete org, assign/strip owner) check
  `tenant.role === 'owner'` explicitly — `manage Tenant` is also held by support and global admins.
  A `SideNav` item uses the SAME guard as the page it opens. All cosmetic; the server enforces
- **Feature flags (D30)**: gate with `{ feature: 'x' }` as a `NavGuard`, or `useFeature('x')` —
  both read `session.features`; `useNavGuard` answers `{ feature }` BEFORE the tenant check (a
  feature that is off is off for everyone). **Never `{ action: 'access', subject: 'Feature:x' }`**:
  a global admin's `manage all` satisfies the CASL form, so they would see a nav item whose routes
  the server 404s — and the app this rule came from shipped exactly that. The flag is
  configuration; only `session.features` answers it
- A `NavGuard` may be a LIST meaning AND, which is how a flag composes with a permission
  (`featureGuard(MY_FEATURE, { action: 'read', subject: 'Thing' })`) — the flag and the permission
  stay two readable facts instead of one conflated subject. One const per feature, so the nav, the
  routes and the settings tabs cannot drift — in `lib/feature-guards.ts` for an app's own flag
  (the kit ships none there; that file exports only `featureGuard`), and beside the route and nav
  item it gates for a plugin's (D31). The gated code still ships in the bundle. Tests drive the
  REAL `useNavGuard`, for a global admin and an owner

## Conventions

- Pages in `pages/` (lazy in `App.tsx`), reusable primitives in `components/shared/` — check there
  before writing a modal, empty state, toast, pagination control or section panel
- **A surface somebody is asked to ACT on is a page, not a modal.** A run (`/agents/runs/:runId`,
  issue #17) is arrived at from a notification, may need a document read before deciding, and is
  left and returned to — so it has its own route, its own lazy chunk, a breadcrumb, and no
  `role="dialog"`. The decision panel is pinned ABOVE the content, **focus lands on its heading and
  never on the destructive button**, and a non-approver sees one sentence rather than a disabled
  control with a tooltip. A conflict (409) is rendered as `alert-info` plus a refetch —
  *information, not an error*: no toast and no red for "somebody else got there first"
- **A countdown chooses its own tick rate from a pure function.** `expiryState(expiresAt, now) →
  { tickMs }` — a second under an hour, a minute under a day, `null` beyond. A naive one-second
  interval on a seven-day deadline is ~600 000 re-renders of a panel nobody is watching
- **A growing list windows; it does not virtualise.** Render the last N groups plus one "show
  earlier" button. Virtualising needs measurement, and measurement fights both auto-scroll and
  collapsible rows. Auto-scroll fires only when the reader is at the bottom AND the last row's
  **id** changed — keying on height yanks them down whenever they expand something old
- **A live count in the nav is `NavItem.badgeKey` resolved in `SideNav`**, never a hook inside
  `navigationConfig`: that const is plain data consumed by the pure, tested `filterNavConfig` — do
  not make it a hook. Feed it from a query-key root the server already nudges — **never a poll** —
  and **render a dot on the icon when the nav is collapsed**, or the badge is invisible to everyone
  who collapsed the sidebar
- **A notification's `data` is its deep link.** One `notificationLink(notification)` helper
  (`lib/notificationLink.ts`) mapping `type` + `data` → a path (unknown → `null`), used by the bell
  AND the list, so a row means the same thing in both places
- `components/ai/` (`Markdown`, `ChatBubble`, `StatRows`) is deliberately NOT exported from the
  `components/shared` barrel that `App.tsx` imports eagerly: `react-markdown` + `remark-gfm` must
  ship only in the lazy chat / agents / documents chunks, never the main bundle. Import them by
  path from lazy pages ONLY — `pages/chat/**`, `pages/agents/**`,
  `pages/documents/DocumentViewPage.tsx` (and the lazy Guide chat): `DocumentsPage` and
  `SearchPage` live in that folder too and must NOT import it. The converse rule holds for
  `components/shared`, nothing under which may import a markdown renderer — which is why
  `DocumentCard` renders its excerpt as plain text (`tests/config/ui-bundle.test.ts` asserts both
  halves). `Markdown` shows images as links (`MarkdownImageLink`, also for a plugin's own
  renderer): text from a model or a document must not make the browser fetch anything by itself.
  Render model output through `Markdown` (`skipHtml`, links `noopener`), never
  `dangerouslySetInnerHTML`; user text renders verbatim (`whitespace-pre-wrap`). Vite emits one
  shared `Markdown-*.js`. The ONE raw-HTML renderer is the Guide's (`pages/guide/CLAUDE.md`)
- Heavy dependencies stay in a lazy chunk, never reached from the `components/shared` barrel,
  `App.tsx`, `SideNav` or a hook the shell loads eagerly. When you touch an import, compare
  `pnpm web build:ui` output before and after — the delta is the check, not any figure a doc could
  quote
- **Visibility (D29)**: `AccessPicker` / `AccessBadge` / `VisibilityModal` in `components/shared`
  are the ONE wording of "who can see this" — markdown-free by construction, which is what lets
  them live in the eager barrel. `AccessPicker` is a radio for the organisation or a set of groups,
  chips grouped by type; `VisibilityModal` wraps it for a list row / a header; `AccessBadge` is the
  read-only lock + names. Render them only where the save would succeed (owner or
  `manage Document`; `manage Dashboard`), and offer an admin every group and a member only their
  own (`useMyGroups`) — the same rule `resolveRequestedVisibility` applies, so the picker cannot
  offer what the API would refuse. An EMPTY selection is WARNED about, never blocked: "only me and
  admins" is a real answer and the state a deleted group leaves behind

## Tests

`tests/ui/` (jsdom + Testing Library; `fetch` via `stubFetch()` route tables, no MSW) — run with
`pnpm web test:ui`. Wrap with `renderWithProviders(ui, { session })`; `makeSession()` builds a
post-parse session whose `permissions` come from the real matrix via `packRules(buildAbility(...))`.
Each feature's test files are listed in its nested `CLAUDE.md`.

## Plugins (D31) — `UiPlugin`, `src/plugins/ui.ts`

A plugin's UI half is `apps/web/src/plugins/<id>/ui/index.ts` (`UiPlugin`,
`apps/web/src/plugins/types.ts`), one line in `src/plugins/ui.ts`, and that entry is the whole of
what the eager shell sees. The seam itself: `apps/web/src/plugins/CLAUDE.md`. The rules follow
from that one fact:

- **Nothing in the shell names a plugin** — that is what makes install and remove a handful of
  barrel lines, and reversible by deleting a directory. `App.tsx` maps
  `UI_PLUGINS.flatMap(p => p.routes)` per tier inside the existing `Suspense`; `SideNav`'s
  `navigationConfig` is `composeNav(CORE_NAVIGATION, …)`; `SettingsLayout` appends
  `settingsTabs(ctx)`; `queryKeys` is `CORE_QUERY_KEYS` spread with every plugin's families;
  `pages/agents/forms/index.ts` is `CORE_AGENT_FORMS` plus every plugin's `agentForms`
- **The UI kit is two modules, and which one you may import depends on where you are.**
  `@/plugins/api/ui-wiring` is the WIRING half — `NavItem`, `NavGroup`, `NavGuard`, `TabConfig`,
  `QuickLink`, `useNavGuard`, `featureGuard` — and is the only host module a plugin's `ui/index.ts`
  may import, because that file ships in the MAIN bundle for every reader including the ones who
  never open the plugin. `@/plugins/api/ui` is the COMPONENTS half, for a lazy PAGE: all of
  `components/shared`, `LoadingIndicator`, `showToast` (exported once, from here — the kit reaches
  it by two public paths and one plugin took each, which is how two call sites of one function
  come to look like two functions) and `SideNav` itself, for the test that drives the REAL nav
  rather than a re-implementation of its guards. `uiEntryIssues` draws this line
- **`routes` are per tier** (`shell` — the default, inside `Layout` with a tenant — `noTenant`,
  `public`) and every `Component` is `lazy(() => import('./pages/X'))` (the analytics plugin's
  `/analytics`, `/analytics/explore`, `/analytics/:pageId`). A statically imported page puts the
  plugin in the main bundle for readers who never open it; `tests/config/plugins.test.ts` reads the
  SOURCE of the UI entry and enforces both halves — an import allowlist (`react`,
  `@heroicons/react/24/outline`, `@rocketpod/shared/*`, `@/plugins/types`,
  `@/plugins/api/ui-wiring`, `@/ui/components/SideNav`, `@/ui/hooks/useNavGuard`,
  `@/ui/lib/feature-guards`; type-only imports are unrestricted because they are erased) and
  "every dynamic `import()` is inside `lazy(() => …)`"
- **The route's guard and its nav item's guard are the SAME object**, declared once beside them, so
  a link can never point at a page its reader cannot open — `EXAMPLE_FEATURE_GUARD` is the pattern
- **`nav` is a list of GROUPS**, spliced by `composeNav(CORE_NAVIGATION, …)`: `before: '<label>'`
  inserts before that core group (the kit's own default is "Organisation"), and a group with no
  `before` lands above it, which is where an app's own features go. A label that is not found
  appends. The kit's nav literal is `CORE_NAVIGATION`; `navigationConfig` is the composed result,
  and `filterNavConfig` is unchanged — plugin items obey the same guards
- `settingsTabs(ctx)` appends tabs after the kit's (`ctx.can` is the caller's ability);
  `agentForms` is the plugin's half of `AGENT_FORMS`
- **`queryKeys` roots must start with `<id>:`** (checked by `plugins.test.ts`), so one plugin's
  invalidation can never reach another's cache. **The `entity` string of a nudge IS a query-key
  family root**, so declare it once (the plugin's `shared.ts`) — `example-feature`'s
  `EXAMPLE_NOTES_ENTITY` is both the server's nudge entity and the UI's family root — and
  `invalidationsFor()` covers it with no hook-side socket code
- A plugin's own hooks (`src/plugins/<id>/ui/hooks/`; the analytics plugin's are
  `useAnalyticsPages`, `useCubeMeta` and `useDashboardDateFilter`) read its own `query-keys.ts`
  directly rather than the merged `queryKeys`: the merge is for the HOST's benefit, and a plugin
  must behave the same whether it is the only one installed or the fifth
- **Components and heavy dependencies stay in its own lazy chunk (D19)**: a plugin's components
  live in `src/plugins/<id>/ui/components/` and are never exported from the shared barrel. The
  analytics plugin's `drizzle-cube/client`, `recharts`, `d3`, `react-grid-layout` and `react-is` are
  reached only from its own pages and components — `grep recharts dist/ui/assets/index-*.js` must
  stay at 0. A registry the browser reads must be a separate file from the one that composes other
  plugins' contributions (importing the composing one drags `postgres` into the UI bundle —
  measured)
- **CSS**: an installed plugin's own pages are scanned by
  `@source "../plugins/**/ui/**/*.{ts,tsx}"` in `index.css` — without it a plugin page renders
  unstyled with nothing in the console to say why. A plugin's own CSS is imported beside the
  library's in its lazy component, never added to `index.css`. drizzle-cube (the analytics
  plugin's) needs NO scan line: its styles are precompiled and `dc:`-prefixed in
  `drizzle-cube/client/styles.css`, loaded by that plugin's lazy chunk, so scanning its dist
  generated zero of its classes and a pile of stray DaisyUI components — pure cost, measured, then
  removed
- A plugin may need an alias in `vite.config.ts` pointing at a file in ITS tree (the analytics
  plugin's `@nivo/heatmap` stub; `docs/ADAPTING.md` §3b to enable heat maps) — one of the core
  lines its install prints, since a plugin edits no core file
- **Third-party providers with their own TanStack Query** (drizzle-cube does this): the app's
  global `QueryCache.onError` never sees their failures. Wrap them (the analytics plugin's
  `CubeClientProvider`) with a dedicated `QueryClient` whose `onError` maps 401 →
  `notifyUnauthorized`, and pass cookie auth explicitly (`credentials: 'include'`,
  `X-Requested-With`). Kit hooks rendered inside still resolve the app's client
- **Dashboards** (the analytics plugin's): edit mode autosaves the whole config (debounced 1.5 s
  PATCH); there is no router-level unsaved-changes blocker — `beforeunload` while dirty plus a
  flush when leaving edit mode/unmount. `useFactTableStatus({ enabled })` MUST be gated on
  `manage Dashboard` (admin-only endpoint). `syncDarkClass` mirrors `data-theme="rocketpod-dark"`
  into a `dark` class only while an analytics surface is mounted (drizzle-cube detects `.dark`);
  kit CSS never reads `.dark`. Visibility appears in the dashboard header's ⋯ menu
  (`manage Dashboard`) and as badges on the dashboard cards
