# Rocketpod roadmap

## Where it stands

Rocketpod runs as **Node 24 in Docker or Kubernetes**, with **Postgres** (+ pgvector) for everything
stateful and **S3-compatible storage** for files: tenancy, auth, CASL, contracts-first, jobs (pg-boss),
agents with durable runs (OpenWorkflow), realtime (`ws` + LISTEN/NOTIFY), knowledge/RAG, tracing,
evals, plugins and the CLI. Deploys are Compose and Helm, with multiple replicas, cross-process
realtime and a singleton cron. The design of the runtime is `docs/DESIGN-SELFHOSTED.md`; what each
subsystem does, and its known gaps, is `docs/CONCEPTS.md`.

## Next

In rough order:

- **First release** — `pnpm kit:release 0.1.0` and push the tag (user-confirmed: it publishes the
  image through `image.yml`). Until a tag exists `pnpm kit:upgrade` has nothing to port, and the local
  `0.1.0`…`0.19.0` tags are Rocketflare's, inherited by the fork, not Rocketpod releases.
- **CLI on npm** — there is no publish workflow: add one (on a tag, `apps/cli` built with esbuild,
  published as `rocketpod` or `@rocketpod/cli`; `@rocketpod/shared` stays private, so the CLI must
  bundle what it imports from it).
- **Analytics in the default set** — a release of the analytics plugin in `rocketflare-plugins` with
  no platform `bindings` and a `minKit` this kit satisfies, then restore it in `defaultPlugins` (and
  the `launch.kit.json` mirror).
- **Operations** — dead-letter redrive tooling (a CLI command or admin page over `boss.redrive`);
  the OpenWorkflow dashboard behind the app's auth (or an authenticated proxy in the chart); pg-boss
  and realtime metrics.
- **Live verification** — `helm install` on kind with 2 web and 3 worker replicas (the Verification
  list below); image signing / SBOM in `image.yml`.
- **Plugin durable workflows** — a way for a plugin to register its own OpenWorkflow workflow
  through the plugin context.
- **Jobs: one job per fetch, woken on send** — `processJobsBatch` runs a batch's jobs one after
  another, so a batch of 10 queues jobs behind each other inside one consumer. One per fetch needs
  pg-boss to fetch again at once after each job (pg-boss bursts only for `batchSize > 1`) and,
  ideally, notify queues that wake a worker on send. Agentic Mapper is building both (uncommitted
  there as of 2026-10-22); port them together, never the batch size alone.
- **Office spreadsheets** — Excel and OpenDocument uploads are not converted (a permanent
  `format: 'error'`); a converter for them joins `src/node/converter.ts`.

**From the first app built on the kit** (Agentic Mapper, `~/work/agentic-mapper`) — generic, but
large or still carrying its domain; each has a porting note in that app's
`docs/upgrades/unreleased.md`:

- **In-app eval experiments** (`6b91b18`…`e5315e2`): a models × prompts × thinking grid run as
  jobs in a hidden system tenant with a spend ceiling, Pareto plots of quality against cost and
  latency, "apply winner" into `agent_models` / platform defaults / prompt overrides, champions
  with drift detection, and "make this session a case" through a PII redactor. Ship the engine
  with the chat-compaction and decisions targets; the app's judges and targets are its own.
- **Transcription scope** (`4bf5a82`): an OpenAI-compatible `transcription` AI scope with
  `verbose_json` / `diarized_json` normalised and recorded fixtures.
- **Rerank** (`services/ai/rerank.ts`): Cohere-style `/rerank` for Cohere, Voyage and Fireworks,
  never throwing — behind an optional `RERANK_*`.
- **⌘K global search** (`d6de732`): the accessible `<dialog>` combobox and search page; needs a
  "searchable kinds" registry plugins contribute to.
- **Media recording** (`763ec75`…): `Platform.media` over ffmpeg, the browser chunk store (OPFS →
  IndexedDB → memory) and ordered resumable uploader, real per-engine recording fixtures.
- **Recipes**: vendoring a private package as workspace source (`scripts/vendor-interviewkit.mjs`,
  re-applied patches, `--check`), and a forced-command SSH deploy (`deploy/nearform`: the key can
  only run `deploy <semver>`, a dump before each deploy, `compose up --wait`).

## Verification

- `pnpm gate` is green with the integration tests against test Postgres + the S3 gateway:
  - pg-boss retry and DLQ
  - step replay after a crash; `waitForEvent` timeout and resume; terminate
  - NOTIFY fan-out across two hub instances
  - an S3 round-trip, metadata, list and `deleteMany`
  - a race on the rate limit and on the lock
  - `platform-seam.test.ts`: no edge-runtime imports or types in the tree
- `docker compose up` with an AI key, then:
  - dev-login
  - upload a PDF → the S3 store → converted → embedded → found by chat
  - an agent run that interrupts → resume it from the UI
  - kill `worker` mid-run → it resumes with no duplicate `agent_run_effects`
- On kind + Helm with 2 web and 3 worker replicas:
  - the migrate Job runs once
  - the daily cron fires once
  - a realtime nudge crosses pods
  - a rolling restart drops no jobs
- The CLI: `rocketpod login --server http://localhost:3001` → `whoami`, `agents run`.
