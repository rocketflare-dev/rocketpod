---
version: unreleased
previous: 0.44.1
date: null
breaking: true
migrations: []
areas: [api, config, docs, deploy]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Email goes through a new `mailer` platform member, and Amazon SES v2 joins Resend as a provider (`EMAIL_PROVIDER=log|resend|ses`), so a deployment on AWS sends with its ECS task role and no API key.

- `Platform.mailer` (`src/platform/types.ts`: `Mailer`, `OutgoingEmail`) is built by `src/node/mailer.ts` — `createMailer(config)`: Resend over `fetch`, SES through `@aws-sdk/client-sesv2` `SendEmailCommand` on the SDK's default credential chain, or null for `log`.
- Unset `EMAIL_PROVIDER` behaves exactly as before: `resend` when `RESEND_API_KEY` is set, else `log`. `loadConfig` now refuses `EMAIL_PROVIDER=resend` without `RESEND_API_KEY`, and `EMAIL_PROVIDER=ses` without `EMAIL_FROM`.
- New vars: `EMAIL_PROVIDER`, `SES_REGION` (unset = the SDK's `AWS_REGION`), `SES_CONFIGURATION_SET` (named on every SES message when set) — in `.env.example`, the chart's `config`, `docker-compose.yml` and `deploy/compose.env.example`.
- `sendEmail(cfg, mailer, logger, message)` takes the mailer as its second argument; with null it logs as before. `requestMagicLink` and `requestSignInEmail` (`routes/auth/magic-link.ts`) take `mailer` after `cfg`. The `email.send` handler reads `ctx.platform.mailer`.
- `createTestEnv()` has `mailer: null` (every email logged, whatever `RESEND_API_KEY` says); a test of delivery passes `mailer: createResendMailer(key)` or `createSesMailer(config, client)`.
- `hasEmail(cfg)` is true for `resend` and `ses`; `emailProvider(cfg)` names the resolved provider. Design: `docs/CONCEPTS.md` §6; operations: `docs/DEPLOY.md` § Email.

## How to apply

1. Add `"@aws-sdk/client-sesv2"` to `apps/web/package.json` dependencies at the exact version `@aws-sdk/client-s3` is pinned to, then run `pnpm install`.
2. Port `apps/web/src/node/mailer.ts`, the `Mailer`/`OutgoingEmail` types and the `mailer` member of `Platform` and `EMPTY_PLATFORM` in `apps/web/src/platform/types.ts`, and the `mailer` part in `apps/web/src/node/platform.ts` (`createMailer(config)` by default).
3. Port the `EMAIL_PROVIDER`, `SES_REGION` and `SES_CONFIGURATION_SET` keys, the `DEFAULT_EMAIL_FROM` constant, the two `superRefine` checks and `emailProvider`/`hasEmail` in `apps/web/src/config.ts`; add the three keys to `apps/web/.env.example`, the Helm chart's `config:` block in `deploy/helm/rocketpod/values.yaml`, the `&app-env` block of `docker-compose.yml` and `deploy/compose.env.example`.
4. Port `apps/web/src/api/services/email.ts`, `apps/web/src/api/queues/handlers/email-send.ts` and `apps/web/src/api/routes/auth/magic-link.ts`.
5. In the app's own code, change every `sendEmail(cfg, logger, message)` call to `sendEmail(cfg, platform.mailer, logger, message)` (a route reads `c.get('platform').mailer`, a job handler `ctx.platform.mailer`), and every `requestMagicLink(db, cfg, logger, input)` / `requestSignInEmail(db, cfg, logger, input)` call to pass the mailer after `cfg`.
6. In `apps/web/tests/mocks/bindings.ts`, add `'mailer'` to `PLATFORM_KEYS` and `mailer: null` to the base platform; give any of the app's own tests that expected a Resend POST `mailer: createResendMailer('<key>')` (from `@/node/mailer`) in its `createTestEnv` overrides.
7. To send through SES on AWS, set `EMAIL_PROVIDER=ses`, `EMAIL_FROM` to an identity verified in SES, and grant `ses:SendEmail` to the task role (`docs/DEPLOY.md` § Email).

## Conflicts to expect

- `apps/web/src/api/services/email.ts` → `sendEmail` gained a `mailer` parameter and lost its Resend `fetch` → keep the app's templates, take the kit's `sendEmail`.
- `apps/web/tests/mocks/bindings.ts` → `PLATFORM_KEYS` and the base platform gained `mailer` → keep both sides' members.
- `deploy/helm/rocketpod/values.yaml` → three keys after `EMAIL_FROM` in `config:` → keep both sides' keys.

## Verify

1. `pnpm test config apps/web/tests/config/node-mailer.test.ts apps/web/tests/config/packaging.test.ts` passes.
2. `pnpm test api apps/web/tests/api/email.test.ts apps/web/tests/api/jobs-consumer.test.ts` passes.
3. With no `EMAIL_PROVIDER` and no `RESEND_API_KEY`, `pnpm dev` still logs the magic-link URL on a sign-in request.
4. `pnpm gate` prints `✔ pnpm gate passed`.
