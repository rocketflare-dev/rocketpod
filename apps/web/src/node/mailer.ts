/**
 * The `Mailer` the config asks for (`EMAIL_PROVIDER`, `emailProvider`):
 * - `ses` — Amazon SES v2 `SendEmail` on the AWS SDK's default credential chain (on ECS the task
 *   role; locally a profile or the `AWS_*` variables), so there is no key in config. The region is
 *   `SES_REGION`, else the SDK's own (`AWS_REGION`); `SES_CONFIGURATION_SET` is named on every
 *   message when set.
 * - `resend` — Resend's REST API over `fetch` (no SDK).
 * - `log` — no mailer at all (null): `services/email.ts` logs the message instead.
 *
 * Either provider REJECTS on a refusal (a sandbox recipient, an unverified sender, throttling, a
 * 4xx/5xx); `services/email.ts` reports it and the `email.send` job retries.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { type AppConfig, emailProvider } from '../config'
import type { Mailer } from '../platform/types'

const RESEND_URL = 'https://api.resend.com/emails'

/** The mailer `EMAIL_PROVIDER` names, or null for `log`. */
export function createMailer(config: AppConfig): Mailer | null {
  switch (emailProvider(config)) {
    case 'ses':
      return createSesMailer(config)
    case 'resend':
      // loadConfig refuses `EMAIL_PROVIDER=resend` without the key, so it is set here.
      return createResendMailer(config.RESEND_API_KEY as string)
    case 'log':
      return null
  }
}

/** `client` is for tests and scripts that point at another endpoint or credentials. */
export function createSesMailer(
  config: Pick<AppConfig, 'SES_REGION' | 'SES_CONFIGURATION_SET'>,
  client: SESv2Client = new SESv2Client(config.SES_REGION ? { region: config.SES_REGION } : {})
): Mailer {
  return {
    provider: 'ses',
    async send(message) {
      const headers = Object.entries(message.headers ?? {}).map(([Name, Value]) => ({
        Name,
        Value,
      }))
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: message.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: message.html, Charset: 'UTF-8' },
                Text: { Data: message.text, Charset: 'UTF-8' },
              },
              ...(headers.length ? { Headers: headers } : {}),
            },
          },
          ConfigurationSetName: config.SES_CONFIGURATION_SET,
        })
      )
      return { id: result.MessageId }
    },
  }
}

/** A Resend refusal: the status and body are kept for the log line. */
export class ResendError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Resend ${status}`)
    this.name = 'ResendError'
  }
}

/** `fetchImpl` defaults to the global `fetch`, read at send time. */
export function createResendMailer(apiKey: string, fetchImpl?: typeof fetch): Mailer {
  return {
    provider: 'resend',
    async send(message) {
      const res = await (fetchImpl ?? globalThis.fetch)(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.headers ? { headers: message.headers } : {}),
        }),
      })
      if (!res.ok) throw new ResendError(res.status, await res.text())
      const data = (await res.json().catch(() => ({}))) as { id?: string }
      return { id: data.id }
    },
  }
}
