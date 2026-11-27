/**
 * The mailer (`src/node/mailer.ts`): which provider `EMAIL_PROVIDER` (or its absence) selects, the
 * misconfigurations `loadConfig` refuses, and the SES v2 `SendEmail` request the SES mailer puts on
 * the wire — against an in-process HTTP server standing in for SES, so nothing leaves the machine.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sendEmail } from '@/api/services/email'
import { ConfigError, hasEmail, loadConfig } from '@/config'
import { createMailer, createSesMailer } from '@/node/mailer'

const base = { APP_ENV: 'development', APP_URL: 'http://localhost:3001' }
const FROM = 'Acme <noreply@acme.test>'

describe('provider selection', () => {
  it('unset: Resend when RESEND_API_KEY is set, else no mailer (logged)', () => {
    expect(createMailer(loadConfig({ ...base, RESEND_API_KEY: 're_x' }))?.provider).toBe('resend')
    const none = loadConfig({ ...base, RESEND_API_KEY: '' })
    expect(createMailer(none)).toBeNull()
    expect(hasEmail(none)).toBe(false)
  })

  it('EMAIL_PROVIDER=log logs even with a Resend key', () => {
    const cfg = loadConfig({ ...base, EMAIL_PROVIDER: 'log', RESEND_API_KEY: 're_x' })
    expect(createMailer(cfg)).toBeNull()
    expect(hasEmail(cfg)).toBe(false)
  })

  it('EMAIL_PROVIDER=ses selects SES with no key in config, and wins over a Resend key', () => {
    const cfg = loadConfig({
      ...base,
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM: FROM,
      RESEND_API_KEY: 're_x',
    })
    expect(createMailer(cfg)?.provider).toBe('ses')
    expect(hasEmail(cfg)).toBe(true)
  })

  it('refuses EMAIL_PROVIDER=resend without RESEND_API_KEY', () => {
    const load = () => loadConfig({ ...base, EMAIL_PROVIDER: 'resend' })
    expect(load).toThrow(ConfigError)
    expect(load).toThrow(/EMAIL_PROVIDER: EMAIL_PROVIDER=resend needs RESEND_API_KEY/)
  })

  it('refuses EMAIL_PROVIDER=ses without EMAIL_FROM', () => {
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'ses' })).toThrow(/EMAIL_FROM/)
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'ses', EMAIL_FROM: FROM })).not.toThrow()
  })

  it('refuses an unknown provider', () => {
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'smtp' })).toThrow(/EMAIL_PROVIDER/)
  })
})

// ---- SES request shaping ------------------------------------------------------------------------

interface Captured {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

let server: Server
let endpoint: string
let captured: Captured[] = []
let answer: { status: number; body: unknown } = { status: 200, body: {} }

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      })
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

beforeEach(() => {
  captured = []
  answer = { status: 200, body: { MessageId: 'ses-msg-1' } }
})

/** The SES mailer against the fake endpoint, with static credentials (no default chain). */
function sesMailer(configurationSet?: string) {
  const client = new SESv2Client({
    region: 'eu-west-1',
    endpoint,
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
    maxAttempts: 1,
  })
  return createSesMailer(
    { SES_REGION: 'eu-west-1', SES_CONFIGURATION_SET: configurationSet },
    client
  )
}

describe('the SES mailer', () => {
  it('sends one signed SendEmail carrying from, to, subject, both bodies and the configuration set', async () => {
    const result = await sesMailer('app-events').send({
      from: FROM,
      to: 'b@example.test',
      subject: 'Sign in to Acme',
      html: '<p>Click</p>',
      text: 'Click',
      headers: { 'List-Unsubscribe': '<mailto:unsub@acme.test>' },
    })
    expect(result).toEqual({ id: 'ses-msg-1' })
    expect(captured).toHaveLength(1)
    const [req] = captured
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe('/v2/email/outbound-emails')
    expect(String(req?.headers.authorization)).toContain('/eu-west-1/ses/aws4_request')
    expect(req?.body).toEqual({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: ['b@example.test'] },
      Content: {
        Simple: {
          Subject: { Data: 'Sign in to Acme', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Click</p>', Charset: 'UTF-8' },
            Text: { Data: 'Click', Charset: 'UTF-8' },
          },
          Headers: [{ Name: 'List-Unsubscribe', Value: '<mailto:unsub@acme.test>' }],
        },
      },
      ConfigurationSetName: 'app-events',
    })
  })

  it('names no configuration set when none is configured', async () => {
    await sesMailer().send({ from: FROM, to: 'c@example.test', subject: 'S', html: 'h', text: 't' })
    expect(captured[0]?.body).not.toHaveProperty('ConfigurationSetName')
    expect(captured[0]?.body.Content).not.toHaveProperty('Simple.Headers')
  })

  it('through sendEmail: EMAIL_FROM is the sender, and an SES refusal is reported, not thrown', async () => {
    const cfg = loadConfig({ ...base, EMAIL_PROVIDER: 'ses', EMAIL_FROM: FROM })
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const message = { to: 'd@example.test', subject: 'S', html: '<p>h</p>', text: 't' }

    expect(await sendEmail(cfg, sesMailer(), logger, message)).toEqual({
      delivered: true,
      id: 'ses-msg-1',
    })
    expect(captured[0]?.body.FromEmailAddress).toBe(FROM)

    answer = {
      status: 400,
      body: { __type: 'MessageRejected', message: 'Email address is not verified.' },
    }
    const refused = await sendEmail(cfg, sesMailer(), logger, message)
    expect(refused.delivered).toBe(false)
    expect(refused.error).toMatch(/not verified/)
  })
})
