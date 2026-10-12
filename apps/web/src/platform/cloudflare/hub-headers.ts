/**
 * The trusted headers the `/ws` route's adapter hands the `NotificationsHub` Durable Object: the
 * identity it already authenticated. Here, not in the DO's module, so the adapter (which the app
 * reaches through `resolvePlatform`) never pulls `cloudflare:workers` into a non-Worker bundle.
 */
export const HUB_HEADERS = {
  tenantId: 'X-Tenant-Id',
  userId: 'X-User-Id',
  sessionId: 'X-Session-Id',
} as const
