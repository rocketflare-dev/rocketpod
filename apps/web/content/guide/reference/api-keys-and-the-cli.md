---
title: API keys and the CLI
part: reference
section: reference
order: 10
audience: member
summary: Sign the command-line tool in through your browser, what it stores, its exit codes, and the API keys behind it.
sources:
  - apps/cli/src/**
  - apps/web/src/api/routes/auth/cli.ts
  - apps/web/src/api/routes/keys.ts
  - apps/web/src/ui/pages/settings/ApiKeys.tsx
  - packages/shared/src/api-keys.ts
verified: 790a55b
---

# API keys and the CLI

The command-line tool, `{{fact:cli.bin}}`, talks to the same server you use in the browser. It
signs in with an **API key**: a long secret tied to you and to one organisation.

## Sign the CLI in

```bash
{{fact:cli.bin}} login --server https://your-server.example
```

Your browser opens on the sign-in page. Sign in if you are not already, pick the organisation, and
the browser hands a new key back to the CLI. You can close the tab.

To do this, the CLI listens on your own machine for a moment, on the first free port from
{{fact:cli.login.port_start}} to {{fact:cli.login.port_end}}. If all of them are busy, or you do
not finish within {{fact:cli.login.timeout_minutes}} minutes, the login stops and nothing is saved.
Run it again.

Without `--server` the CLI uses the server it last signed in to, else
{{fact:cli.default_server_url}}.

## What the CLI stores

The key is saved in {{fact:cli.config_file}}, readable only by you. The CLI never prints the whole
key — only its first few characters.

```bash
{{fact:cli.bin}} whoami     # who you are signed in as, and in which organisation
{{fact:cli.bin}} status     # is the server up, and is the key still good
{{fact:cli.bin}} logout     # forget the stored key
```

In a script or a CI job there is no browser. Set {{fact:cli.env.api_key}} (and
{{fact:cli.env.url}} for the server) instead of running `login`.

## Exit codes

| Code | Meaning |
|---|---|
| {{fact:cli.exit.ok}} | It worked |
| {{fact:cli.exit.error}} | Something failed — the message says what |
| {{fact:cli.exit.not_logged_in}} | Not signed in, or the key no longer works — run `login` |
| {{fact:cli.exit.forbidden}} | Signed in, but your role does not allow this |

Every list command takes `--json` for output another program can read.

## API keys

A key carries scopes, one or more of {{fact:api_keys.scopes}}. The CLI's own key is named after
your machine and carries `*`.

Admins see every key of the organisation in **Settings → API keys**. There they can create a key
for a script and revoke any key. A new key is shown once, when it is created — copy it then.
Revoking a key stops every request that uses it at once.

> **WATCH OUT** — A key acts as you. Keep it out of chat messages, tickets and source code.
