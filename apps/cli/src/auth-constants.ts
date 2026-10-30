/**
 * The login handoff's numbers, in a module of their own with no imports: `auth.ts` uses them,
 * and the web app's Guide pins them as facts (`apps/web/src/api/services/guide-facts.ts`) — its
 * drift test reads them from here without loading the CLI's HTTP client.
 */
export const CALLBACK_PORT_START = 8765
export const CALLBACK_PORT_END = 8770
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
