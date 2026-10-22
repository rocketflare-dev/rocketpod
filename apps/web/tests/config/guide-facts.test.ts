/**
 * The Guide's facts registry: the pinned facts equal the constants they stand for (the server
 * bundle never imports `apps/cli`, and the registry does not load the heavier server modules, so
 * this test is what keeps each literal true), imported facts follow their live constant, and an
 * unknown key never renders.
 */
import { BULK_INVITE_MAX, tenantRoleSchema } from '@rocketpod/shared/tenants'
import { describe, expect, it } from 'vitest'
import { MAGIC_LINK_TTL_MS } from '@/api/auth/magic-link'
import {
  GUIDE_FACTS,
  guideFactKeys,
  PINNED_FACTS,
  resolveGuideFacts,
  thousands,
  UnknownGuideFactError,
} from '@/api/services/guide-facts'
import { INVITATION_TTL_MS } from '@/api/services/invitations'
// The CLI's constants: apps/web never imports the CLI at runtime — only this test reads them,
// because the facts registry pins their values.
import {
  CALLBACK_PORT_END,
  CALLBACK_PORT_START,
  LOGIN_TIMEOUT_MS,
} from '../../../cli/src/auth-constants'
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, DEFAULT_SERVER_URL, ENV } from '../../../cli/src/config'
import { EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN, EXIT_OK } from '../../../cli/src/errors'
import { BIN_NAME } from '../../../cli/src/package-info'

/** Each pinned fact, rendered from its real constant. A new pinned fact needs a line here. */
const PINNED_FROM_CODE: Record<keyof typeof PINNED_FACTS, string> = {
  'cli.bin': BIN_NAME,
  'cli.login.port_start': String(CALLBACK_PORT_START),
  'cli.login.port_end': String(CALLBACK_PORT_END),
  'cli.login.timeout_minutes': String(LOGIN_TIMEOUT_MS / 60_000),
  'cli.config_file': `\`~/${CONFIG_DIR_NAME}/${CONFIG_FILE_NAME}\``,
  'cli.env.api_key': `\`${ENV.apiKey}\``,
  'cli.env.url': `\`${ENV.url}\``,
  'cli.default_server_url': `\`${DEFAULT_SERVER_URL}\``,
  'cli.exit.ok': String(EXIT_OK),
  'cli.exit.error': String(EXIT_ERROR),
  'cli.exit.not_logged_in': String(EXIT_NOT_LOGGED_IN),
  'cli.exit.forbidden': String(EXIT_FORBIDDEN),
  'auth.magic_link_minutes': String(MAGIC_LINK_TTL_MS / 60_000),
  'team.invitation_days': String(INVITATION_TTL_MS / (24 * 60 * 60 * 1000)),
}

describe('the Guide facts registry', () => {
  it('every pinned fact equals the constant it stands for', () => {
    expect(PINNED_FACTS).toEqual(PINNED_FROM_CODE)
  })

  it('resolves imported facts from the live constant', () => {
    expect(resolveGuideFacts('up to {{fact:team.bulk_invite_max}} people')).toBe(
      `up to ${thousands(BULK_INVITE_MAX)} people`
    )
    for (const role of tenantRoleSchema.options) {
      expect(GUIDE_FACTS['team.roles']).toContain(`\`${role}\``)
    }
  })

  it('renders a duration or a byte limit as a whole number', () => {
    // A limit that stops being a whole number of its unit would print as `1.9073486328125`.
    for (const key of ['files.max_upload_mb', 'auth.session_days']) {
      expect(GUIDE_FACTS[key]).toMatch(/^\d+$/)
    }
  })

  it('throws on an unknown key and lists the keys a body names', () => {
    expect(() => resolveGuideFacts('{{fact:no.such}}')).toThrow(UnknownGuideFactError)
    expect(guideFactKeys('{{ fact:a.b }} and {{fact:a.b}} {{fact:c}}')).toEqual(['a.b', 'c'])
  })
})
