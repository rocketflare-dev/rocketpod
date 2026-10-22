---
title: Signing in
part: start
section: start-here
order: 10
audience: member
summary: The ways to sign in, how long a sign-in lasts, and how to add a second way in so you are never locked out.
sources:
  - apps/web/src/ui/pages/Login.tsx
  - apps/web/src/ui/pages/Profile.tsx
  - apps/web/src/api/routes/auth/**
  - apps/web/src/api/auth/magic-link.ts
  - apps/web/src/api/auth/cookies.ts
verified: 790a55b
---

# Signing in

The sign-in page shows only the ways in that your organisation has turned on. You will see some of
these:

- **A provider button** — "Continue with Google", "Continue with Microsoft", or your company's
  single sign-on. You are sent to the provider and back.
- **Email me a sign-in link** — type your work email address and we send you a link. There is no
  password to remember.

Some organisations use single sign-on only. Then the page shows one button and nothing else.

## Email sign-in links

A link works once, and only for {{fact:auth.magic_link_minutes}} minutes after it is sent. If it
has expired, or you already used it, go back to the sign-in page and ask for a new one.

> **IN PRACTICE** — The link signs in whoever opens it, so do not forward the email.

## How long you stay signed in

A sign-in lasts {{fact:auth.session_days}} days on that browser. Signing out from the user menu ends
it at once.

## Add a second way in

Open **Profile** from the user menu. Under **Sign-in methods** you can connect another provider
to your account. Connect more than one, so that losing access to one account does not lock you out.
You cannot disconnect your only way in.

## If you belong to more than one organisation

After you sign in you pick an organisation. You can switch at any time from the organisation menu
at the top of the page. What you can do in each depends on your role there: one of
{{fact:team.roles}}. Owners and admins manage the organisation's settings; members use it. Ask an
admin if you need more access.

To use the app from a terminal, see [API keys and the CLI](../reference/api-keys-and-the-cli.md).
