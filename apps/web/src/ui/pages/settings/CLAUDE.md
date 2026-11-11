# Settings UI (`/settings`)

One page, `SettingsLayout` with `URLTabs`
(`?tab=general|people|groups|api-keys|ai|prompts|agent-models|usage`), behind
`RequireGuard guard="admin"`. `groups` renders only for `manage Group`, `agent-models` and `usage`
only for `manage AiConfig` — a tab, picker or table you cannot save from is worse than no tab.
`ai` and `prompts` degrade to read-only inside; owner-only content (slug, delete org) gates inside
its tab. Installed plugins append tabs LAST via `settingsTabs(ctx)`.

Hooks: `useAiConfig` (`useAiConfigs` / `useAiProviders` / `useAiReadiness`, `useUpsertAiConfig`,
`useDeleteAiConfig`, `useTestAiConfig`; `providersForScope`, `configsForScope`), `usePrompts`
(`usePrompts`, `useUpdatePrompt`, `useClearPrompt`), `useAiUsage` (`useAiUsageSummary(days)`,
keyed on the PRESET, window derived in `queryFn`), `useAgentModels` (`useAgentModels`,
`useUpsertAgentModel`, `useDeleteAgentModel`), `useGroups` (below).

## AI (`AI.tsx`, `AiConfigModal.tsx`, `hooks/useAiConfig.ts`)

- The providers catalog (`GET /api/ai/config/providers`) has NO shared schema (it is
  `services/ai/providers.ts` data), so `useAiConfig.ts` carries a permissive `passthrough` one.
  `PROVIDER_PRESETS`/`presetsFor`, `DEFAULT_MODELS`, `THINKING_*` come from
  `@rocketpod/shared/ai/config`.
- The label is the upsert key `(tenant, scope, label)` — read-only on edit (renaming would create a
  second row). `apiKey` is write-only: blank on edit keeps the stored key (`hasCredential`);
  switching provider on edit requires a new key. `serviceTier: ''` clears. "Set default" re-posts
  the row with `isDefault: true` and no `apiKey`.
- A member (`read AiConfig` / `read Prompt`) has no nav path to `/settings`, so the read-only
  rendering of the AI and Prompts tabs is exercised component-level in tests only.

## Agent models (`AgentModels.tsx`, `hooks/useAgentModels.ts`)

- `GET /api/ai/agent-models` is the whole truth (every prompt key, its assignment, and the
  effective provider/model/source the server's planner computed) — the page never re-derives it.
- Override modal: pick a chat `ai_configs` row (`configsForScope(configs, 'chat')`; blank = keep
  the default config) and/or type a model; validated with `upsertAgentModelRequestSchema` (at least
  one), and `PUT` sends ONLY the set fields (the PUT replaces the row, so a blank model clears it).
  "Use default" is `DELETE` — absence is the default.
- Source badges: `agent` (assignment), `tenant`, `platform pick` (`platform_default`), `platform`,
  `none` (→ EmptyState linking `/settings?tab=ai`).

## Groups (`Groups.tsx`, `GroupMembersModal.tsx`, `hooks/useGroups.ts`)

- Group TYPES on the left, that type's groups on the right, `GroupMembersModal` for who is in one.
- `hooks/useGroups.ts`: `useGroupTypes`, `useGroups(typeId?)`, `useGroup(id)`, `useMyGroups` (the
  only one a plain member may call), the type/group/member mutations, `useSetMemberGroups`,
  `useSetDocumentVisibility` — one `['groups']` family so a single invalidation covers it.
- **Deleting quotes the 409.** `DELETE /api/groups/:id` (and a type's) answers `group_in_use` with
  one count per restrictable resource while the group still controls access — core `documents`
  plus one per installed plugin (the analytics plugin's `dashboards`), so read the keys
  generically, never as a fixed pair. The confirm dialog shows the counts, says the affected
  content narrows to its owner and administrators (never opens), and only then offers "Delete
  anyway" (`?force=1`).
- People has a Groups column + Edit groups (`MemberGroupsModal`, `useSetMemberGroups`); the profile
  shows a read-only "Your groups" (hidden when you are in none).
- **Freshness is the generic nudge**: the family root is `['groups']`, which the server's
  `entity.changed { entity: 'groups' }` names, and `access.changed` (sent to the affected people
  only) invalidates `['auth'] ['documents'] ['groups']` plus every installed plugin's
  `realtimeRoots` (the analytics plugin's `['analytics:dashboards']`) — so somebody who loses a
  group watches the content disappear instead of clicking into a 404. No hook here touches the
  socket.

## Tests

`tests/ui/`: `ai-settings`, `prompts-settings`, `agent-models-settings`, `usage-settings`, `people`,
`api-keys`, `groups` (the tab's list/create flows, the 409 confirm, and the `AccessPicker`
empty-selection warning).
