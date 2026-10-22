---
title: AI settings
part: admin
section: ai
order: 10
audience: admin
summary: Connect your organisation's own AI providers for chat, search and decisions, test them, and see what answers right now.
sources:
  - apps/web/src/ui/pages/settings/AI.tsx
  - apps/web/src/ui/pages/settings/AiConfigModal.tsx
  - apps/web/src/api/services/ai/resolve.ts
  - apps/web/src/api/services/ai/configs.ts
  - packages/shared/src/ai/config.ts
verified: 790a55b
---

# AI settings

**Settings → AI** decides which AI models your organisation uses. Owners and admins can open it.

## What answers right now

The **Readiness** panel shows one line per kind of work: {{fact:ai.scopes}}.

- **Chat** answers conversations, runs agents and answers Ask the Guide.
- **Embeddings** turns documents into vectors so the knowledge base can search by meaning.
- **Decisions** answers the typed questions some agents ask. Without a decision provider, the chat
  model answers them itself, and its numbers are marked as uncalibrated.

Each line says **Ready** or **Not configured**, and where the answer comes from: **this
workspace** (a provider you added) or **platform default** (the key the operator of this server
set up for everyone). When neither exists, chat and indexing are switched off until you add one.

## Add a provider

1. In the section for the kind of work, select **Add chat provider** (or embedding, or decision).
2. Choose the provider — one of {{fact:ai.providers}}. A preset fills in the address and a model
   for well-known services.
3. Paste the API key from your provider's own console, and give the entry a label.
4. Select **Test** to check the key and model before you save.

The first chat default for Anthropic is {{fact:ai.default_model.anthropic}}, and for OpenAI
{{fact:ai.default_model.openai_chat}}. An embeddings model must produce
{{fact:embeddings.dimensions}}-dimension vectors; the OpenAI default,
{{fact:ai.default_model.embeddings}}, does.

> **RULE OF THUMB** — Use your own key when your organisation wants its AI spend on its own bill,
> or needs a model the platform default does not offer.

## Keys stay secret

Once saved, a key is never shown again — not to you, not to anyone. The table only says that the
entry has one. To change it, edit the entry and paste a new key; leave the field blank to keep the
old one. If you switch an entry to a different provider, you must paste a new key.

## The default entry

You can add more than one provider of each kind. One of them is the **default**, and that is the one
the app uses — unless **Settings → Agent models** points one feature at another. **Set default** on
another row moves it. To remove a provider, use the remove action
on its row.

Members of your organisation sign in as the [signing-in page](../start/signing-in.md) describes;
their chats use the default chat provider you chose here.
