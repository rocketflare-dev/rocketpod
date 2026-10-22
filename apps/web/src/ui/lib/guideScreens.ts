/**
 * Where the reader is, as a hint for "Ask the Guide": a short label, the Guide page for the screen
 * (`GUIDE_SCREEN_PAGES`, the one screen → topic map) and the part to prefer when searching.
 *
 * The label is built ONLY from fixed vocabulary. Path segments are matched against known route
 * shapes and never echoed, so no document title, conversation, person or id — nothing
 * tenant-specific — can reach the global-corpus chat. Pure, so it is tested without rendering.
 *
 * An app adds a line per screen of its own (and its key in `GUIDE_SCREEN_PAGES`).
 */
import type { GuidePart, GuideScreenHint } from '@rocketpod/shared/guide'
import { type GuideScreenKey, guideScreenPage } from '@rocketpod/shared/guide-screens'

const PART_OF: Partial<Record<GuideScreenKey, GuidePart>> = {
  home: 'workspace',
  profile: 'start',
  chat: 'workspace',
  documents: 'workspace',
  agents: 'workspace',
  notifications: 'workspace',
  guide: 'start',
  settings: 'admin',
  'settings-people': 'admin',
  'settings-api-keys': 'reference',
  'settings-ai': 'admin',
  activity: 'admin',
  admin: 'admin',
}

function hint(key: GuideScreenKey, label: string): GuideScreenHint {
  return { label, page: guideScreenPage(key), part: PART_OF[key] ?? null }
}

/** Settings tabs (`?tab=`) with a page of their own. */
const SETTINGS_TABS: Record<string, { key: GuideScreenKey; label: string }> = {
  people: { key: 'settings-people', label: 'Settings › People' },
  'api-keys': { key: 'settings-api-keys', label: 'Settings › API keys' },
  ai: { key: 'settings-ai', label: 'Settings › AI' },
}

/** The screen a route is, or null for a route the Guide has no vocabulary for. */
export function screenForRoute(pathname: string, search = ''): GuideScreenHint | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return hint('home', 'Home')
  if (path === '/profile') return hint('profile', 'Profile')
  if (path === '/notifications') return hint('notifications', 'Notifications')
  if (path === '/chat' || path.startsWith('/chat/')) return hint('chat', 'Chat')
  if (path === '/documents' || path.startsWith('/documents/') || path === '/search') {
    return hint('documents', 'Knowledge')
  }
  if (path === '/agents' || path.startsWith('/agents/')) return hint('agents', 'Agents')
  if (path === '/settings') {
    const tab = SETTINGS_TABS[new URLSearchParams(search).get('tab') ?? '']
    return tab ? hint(tab.key, tab.label) : hint('settings', 'Settings')
  }
  if (path === '/activity') return hint('activity', 'Activity')
  if (path === '/admin' || path.startsWith('/admin/')) return hint('admin', 'Platform admin')
  if (path === '/guide') return hint('guide', 'The Guide')
  return null
}
