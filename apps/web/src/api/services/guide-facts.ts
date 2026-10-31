/**
 * The Guide's facts registry. A page never types a number, limit or on-screen name it could get
 * wrong: it writes `{{fact:<key>}}`, and the key resolves here — at render time AND at index time,
 * so the embeddings see the real values. An unknown key throws, and fails the staleness test
 * (`tests/config/guide-content.test.ts`).
 *
 * Two kinds of value:
 *
 * - **Imported** — built from the constant the product runs on (`@rocketpod/shared`, and server
 *   modules that import nothing heavy). Change the constant and the Guide changes with it.
 * - **Pinned** — constants the server bundle cannot import (`apps/web` never imports `apps/cli`)
 *   or should not load here (a server module that drags the database schema and the job queue in
 *   with it). Each is a literal in {@link PINNED_FACTS}, and `tests/config/guide-facts.test.ts`
 *   asserts it equals the real constant, so a drifted value fails the gate instead of shipping.
 *   Adding one = a literal here + its line in that test.
 *
 * NO import of `config`, the database or anything that reads the env: the staleness test runs
 * without an env file, and the reader test renders pages in jsdom.
 */

import {
  AI_PROVIDERS,
  AI_SCOPES,
  DEFAULT_CHAT_MODELS,
  DEFAULT_MODELS,
  EMBEDDING_DIM,
} from '@rocketpod/shared/ai/config'
import { PROMPT_MAX_LENGTH } from '@rocketpod/shared/ai/prompts'
import { apiKeyScopeSchema } from '@rocketpod/shared/api-keys'
import { signupModeSchema } from '@rocketpod/shared/auth'
import { MAX_UPLOAD_BYTES } from '@rocketpod/shared/files'
import {
  BULK_INVITE_MAX,
  invitationStatusSchema,
  tenantRoleSchema,
} from '@rocketpod/shared/tenants'
import { LABS_SESSION_TTL_MS, SESSION_TTL_MS } from '../auth/cookies'

/** `a`, `a and b`, `a, b and c` — code-formatted, as a page would write them. */
function codeList(values: readonly string[]): string {
  const items = values.map(v => `\`${v}\``)
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** `5,000` — a count as a page would write it. */
export function thousands(n: number): string {
  return n.toLocaleString('en-GB')
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Constants this module does not import, pinned by value. Each key names its owner in the comment;
 * the drift test reads the owner and compares.
 */
export const PINNED_FACTS = {
  /** `BIN_NAME` — apps/cli/src/package-info.ts (plain, so it reads inside a code block) */
  'cli.bin': 'rocketpod',
  /** `CALLBACK_PORT_START`, `CALLBACK_PORT_END`, `LOGIN_TIMEOUT_MS` — apps/cli/src/auth-constants.ts */
  'cli.login.port_start': '8765',
  'cli.login.port_end': '8770',
  'cli.login.timeout_minutes': '5',
  /** `CONFIG_DIR_NAME` + `CONFIG_FILE_NAME` — apps/cli/src/config.ts */
  'cli.config_file': '`~/.rocketpod/config.json`',
  /** `ENV.apiKey`, `ENV.url` — apps/cli/src/config.ts */
  'cli.env.api_key': '`ROCKETPOD_API_KEY`',
  'cli.env.url': '`ROCKETPOD_URL`',
  /** `DEFAULT_SERVER_URL` — apps/cli/src/config.ts */
  'cli.default_server_url': '`http://localhost:3001`',
  /** `EXIT_*` — apps/cli/src/errors.ts */
  'cli.exit.ok': '0',
  'cli.exit.error': '1',
  'cli.exit.not_logged_in': '2',
  'cli.exit.forbidden': '3',
  /** `MAGIC_LINK_TTL_MS` — apps/web/src/api/auth/magic-link.ts (imports the schema) */
  'auth.magic_link_minutes': '15',
  /** `INVITATION_TTL_MS` — apps/web/src/api/services/invitations.ts (imports the job queue) */
  'team.invitation_days': '7',
} as const satisfies Record<string, string>

/** Facts built from constants this module imports. */
const IMPORTED_FACTS = {
  'auth.session_days': String(SESSION_TTL_MS / DAY_MS),
  'auth.labs_session_days': String(LABS_SESSION_TTL_MS / DAY_MS),
  'auth.signup_modes': codeList(signupModeSchema.options),
  'team.roles': codeList(tenantRoleSchema.options),
  'team.invitation_statuses': codeList(invitationStatusSchema.options),
  'team.bulk_invite_max': thousands(BULK_INVITE_MAX),
  'api_keys.scopes': codeList(apiKeyScopeSchema.options),
  'ai.scopes': codeList(AI_SCOPES),
  'ai.providers': codeList(AI_PROVIDERS),
  'ai.default_model.anthropic': `\`${DEFAULT_MODELS.anthropic}\``,
  'ai.default_model.openai_chat': `\`${DEFAULT_CHAT_MODELS.openai ?? DEFAULT_MODELS.openai}\``,
  'ai.default_model.embeddings': `\`${DEFAULT_MODELS.openai}\``,
  'embeddings.dimensions': thousands(EMBEDDING_DIM),
  'prompts.max_chars': thousands(PROMPT_MAX_LENGTH),
  'files.max_upload_mb': String(MAX_UPLOAD_BYTES / 1024 / 1024),
} as const satisfies Record<string, string>

export const GUIDE_FACTS: Readonly<Record<string, string>> = {
  ...IMPORTED_FACTS,
  ...PINNED_FACTS,
}

export class UnknownGuideFactError extends Error {
  constructor(readonly key: string) {
    super(`Unknown Guide fact '${key}' — add it to GUIDE_FACTS (src/api/services/guide-facts.ts)`)
    this.name = 'UnknownGuideFactError'
  }
}

const FACT = /\{\{\s*fact:([a-z0-9_.-]+)\s*\}\}/gi

/** Every fact key a markdown body names, in order of first use. */
export function guideFactKeys(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(FACT)].map(m => m[1] as string))]
}

/** The keys a body names that the registry does not know. */
export function unknownGuideFactKeys(markdown: string): string[] {
  return guideFactKeys(markdown).filter(k => !Object.hasOwn(GUIDE_FACTS, k))
}

/** Replace every `{{fact:key}}`; an unknown key throws {@link UnknownGuideFactError}. */
export function resolveGuideFacts(markdown: string): string {
  return markdown.replace(FACT, (_m, key: string) => {
    if (!Object.hasOwn(GUIDE_FACTS, key)) throw new UnknownGuideFactError(key)
    return GUIDE_FACTS[key] as string
  })
}
