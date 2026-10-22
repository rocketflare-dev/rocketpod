/**
 * Screen → Guide page: THE one map from a screen to the help topic that explains it. The Guide
 * chat sends the page with its screen hint (`screenForRoute` in `ui/lib/guideScreens.ts`), and
 * every contextual `GuideLink` takes its target from here, so a screen's help topic is defined
 * once.
 *
 * Values are paths relative to `apps/web/content/guide/`; the staleness test
 * (`tests/config/guide-content.test.ts`) holds every one to a real `member` page — a screen
 * everybody can open must never point at a page some of them cannot read. Screens only admins can
 * open map in {@link GUIDE_ADMIN_SCREEN_PAGES} instead. `null` is a screen with no page of its own.
 *
 * Shared because the server reads it too: the chat names a screen hint's `page` to the model only
 * when it is one of these AND in the asker's own TOC (`routes/guide.ts`).
 *
 * An app adds a line per screen it writes a page for — and deletes the line when it deletes the
 * page (the staleness test fails until it does).
 */
export const GUIDE_SCREEN_PAGES = {
  home: null,
  profile: 'start/signing-in.md',
  chat: null,
  documents: null,
  agents: null,
  notifications: null,
  guide: 'start/signing-in.md',
} as const satisfies Record<string, string | null>

/**
 * Topic → Guide page for a contextual link that is about a TASK rather than a screen (a "how do I
 * use the CLI?" link beside a key). Held to a real `member` page by the same staleness test as
 * {@link GUIDE_SCREEN_PAGES}.
 */
export const GUIDE_TOPIC_PAGES = {
  'sign-in': 'start/signing-in.md',
  cli: 'reference/api-keys-and-the-cli.md',
} as const satisfies Record<string, string>

export type GuideTopicKey = keyof typeof GUIDE_TOPIC_PAGES

/**
 * The screens only admin-level roles can open (Settings and Activity are behind the `admin` guard,
 * Platform admin behind `globalAdmin`) → their `admin`-audience page. Held to a real page of either
 * audience by the same staleness test; the chat still names one only when it is in the asker's own
 * TOC.
 */
export const GUIDE_ADMIN_SCREEN_PAGES = {
  settings: null,
  'settings-people': 'admin/members-and-invitations.md',
  'settings-api-keys': 'reference/api-keys-and-the-cli.md',
  'settings-ai': 'admin/ai-settings.md',
  activity: null,
  admin: null,
} as const satisfies Record<string, string | null>

export type GuideMemberScreenKey = keyof typeof GUIDE_SCREEN_PAGES
export type GuideAdminScreenKey = keyof typeof GUIDE_ADMIN_SCREEN_PAGES
export type GuideScreenKey = GuideMemberScreenKey | GuideAdminScreenKey

/** The page a screen maps to, member or admin. */
export function guideScreenPage(key: GuideScreenKey): string | null {
  return key in GUIDE_SCREEN_PAGES
    ? GUIDE_SCREEN_PAGES[key as GuideMemberScreenKey]
    : GUIDE_ADMIN_SCREEN_PAGES[key as GuideAdminScreenKey]
}
