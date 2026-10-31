---
title: Members and invitations
part: admin
section: organisation
order: 10
audience: admin
summary: Invite people, choose their role, and manage the invitations that have not been accepted yet.
sources:
  - apps/web/src/ui/pages/settings/People.tsx
  - apps/web/src/ui/pages/settings/InviteModal.tsx
  - apps/web/src/api/services/invitations.ts
  - apps/web/src/permissions/abilities.ts
  - packages/shared/src/tenants.ts
  - apps/web/src/api/services/members.ts
verified: 790a55b
---

# Members and invitations

Everything here lives in **Settings → People**. Owners and admins can open it.

## Roles

Each person in the organisation has one role: {{fact:team.roles}}.

| Role | What they can do |
|---|---|
| `owner` | Everything, including deleting the organisation and making someone else an owner |
| `admin` | Invite and remove people, change roles (except owners), manage API keys and AI settings |
| `member` | Use the app: chat, agents and the knowledge base. Settings is not open to them |

Only an owner can give someone the owner role or change an owner's role. Nobody can remove
themselves from this page.

## Invite someone

1. Select **Invite**.
2. Choose **One person** and type their email address, or **Several** and paste up to
   {{fact:team.bulk_invite_max}} addresses, one per line or separated by commas.
3. Pick the role they will join with, then send.

Each person gets an email with a link. The link works for {{fact:team.invitation_days}} days.

> **RULE OF THUMB** — Invite people with the role they need today. You can raise it later in one
> click; taking access back after the fact is harder to explain.

## Pending invitations

Invitations that have not been accepted are listed under **Pending invitations**. An invitation is
one of {{fact:team.invitation_statuses}}.

- **Resend** sends the email again.
- **Revoke** cancels it. The link stops working at once.

When someone accepts, they move to **Members** with the role you chose.

## Change a role or remove someone

In **Members**, change the role with the select on their row, or remove them with the button at
the end of it. A removed person loses access to the organisation straight away.

A row marked **Labs Access** is managed there, not here: it has no role select and no remove
button. Change that person's role or access in Labs Access, and it applies the next time they sign
in. An organisation made by Labs Access starts with no owner; ask a platform administrator for
anything only an owner can do.

People sign in the way the [signing-in page](../start/signing-in.md) describes.
