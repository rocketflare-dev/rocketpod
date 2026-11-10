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
  - apps/web/src/api/auth/providers/**
verified: 790a55b
---

# Signing in

The sign-in page shows only the ways in that your organisation has turned on. You will see some of
these:

- **A provider button** — "Continue with Google", "Continue with Microsoft", or your company's
  single sign-on. You are sent to the provider and back.
- **Email me a sign-in link** — type your work email address and we send you a link. There is no
  password to remember.

Some organisations use single sign-on only. Then the page shows one button and nothing else, and
email sign-in links are switched off altogether.

With **Continue with Microsoft**, your account is matched on your Microsoft sign-in name (your user
principal name), not on a separate mail address. If the two differ, sign in the way you did before
and connect Microsoft from **Profile** first (see below).

Where your company requires its own single sign-on for your email address, the other ways in are
refused for you: asking for an email link sends you a message pointing to your company's sign-in
instead, and the sign-in page opens with that button picked for you.

If single sign-on sends you back with **"You don't have access to this app"**, your sign-in worked
but your organisation has not been given this app. Ask your organisation's administrator to grant
it, then sign in again.

## Email sign-in links

A link works once, and only for {{fact:auth.magic_link_minutes}} minutes after it is sent. If it
has expired, or you already used it, go back to the sign-in page and ask for a new one.

At most {{fact:auth.sign_in_mail_max}} links go to one address in
{{fact:auth.sign_in_mail_window_minutes}} minutes. Past that the page still says a link is on its
way, but none is sent until the time is up — use the newest link you already have, or wait.

> **IN PRACTICE** — The link signs in whoever opens it, so do not forward the email.

## How long you stay signed in

A sign-in lasts {{fact:auth.session_days}} days on that browser. Signing out from the user menu ends
it at once, and closes that browser's live connection to the app. Where your organisation's identity provider decides who may use the app, a sign-in
through it ends a fixed time after you sign in, however often you visit:
{{fact:auth.idp_session_days}} days unless your administrator chose otherwise. Each sign-in
brings your organisations and role up to date.

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
