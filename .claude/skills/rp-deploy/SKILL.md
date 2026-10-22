---
name: rp-deploy
description: Deploy this app as containers — Docker Compose on one host or the Helm chart on Kubernetes. Builds or picks the image, writes the .env or values file, walks the secrets checklist without ever printing a secret, renders and lints the chart, and stops for the user before anything that pushes an image, creates paid resources or touches a live cluster. Use when someone asks to deploy, ship, self-host, run in production, put it on Kubernetes or Docker, or set up a server.
argument-hint: "[compose|helm] [--single]"
---

# Deploy in containers

You are coaching someone from a working checkout to a running deployment. The runbook is
`docs/DEPLOY.md` — read it first and quote it rather than paraphrasing it from memory. The app is
**one image** (`Dockerfile`) that runs `web`, `worker` or `all`, plus a one-shot migrate; Postgres
(with pgvector) and an S3-compatible bucket are outside it.

## Constraints on you (Claude)

- **Never print a secret.** Not a key you generated, not one the user pasted, not one read from
  `.env`, a values file or `kubectl get secret`. Say "set" / "missing" / "too short" — the same way
  the API says `hasCredential`. When you generate one (`openssl rand -base64 32`), write it straight
  into the file with a command that does not echo it, and tell the user which file holds it.
- **Never commit** `.env`, `deploy/values.local.yaml` or anything else holding a secret. Check
  `git check-ignore` for a file before writing secrets into it; add it to `.gitignore` if it is not
  ignored, and say so.
- **Stop and ask with `AskUserQuestion` before** each of these — they are the user's to approve, every
  time, even if an earlier one was approved:
  - pushing an image to a registry (`docker push`, a tag that triggers `image.yml`'s push);
  - pushing a version tag at all. Read `.github/workflows/image.yml` first: when a deploy job hangs
    off it, the tag IS a production deploy, and nothing asks again. Say which it is, and confirm the
    gate's own verdict (`.gate/last.json` `passed` + `full` for that `sha`) before asking;
  - anything against a live cluster: `helm upgrade --install`, `helm uninstall`, `kubectl apply`,
    `kubectl create secret`, `kubectl delete`;
  - creating anything billed: a managed database, a bucket, a load balancer, a DNS record;
  - `docker compose down -v` (deletes the database and bucket volumes).
  Building an image locally, rendering and linting the chart, writing a local `.env` or values file
  and `docker compose up` on the user's own machine are yours to run.
- Your Bash tool has no TTY. Long builds need `timeout: 600000`.
- Show command output as you go; quote failures verbatim.

## 0. Which shape?

Ask (one `AskUserQuestion`, unless the argument already says) between:

| Shape | When | Next |
|---|---|---|
| **Compose, two processes** | one host, a VM, a homelab | §1 |
| **Compose, one process** (`--single`) | the smallest install | §1 with `deploy/compose.single.yml` |
| **Helm** | Kubernetes, more than one replica | §2 |

Then confirm where Postgres and the bucket come from: the bundled `postgres` / `s3` services
(Compose only — fine on one host, not HA) or managed ones (RDS/Cloud SQL/Neon/Supabase with
pgvector; S3, R2, GCS, MinIO…). The chart bundles neither.

## 1. Docker Compose

1. **Image.** `docker build -t rocketpod:local .` (≈ 255 MB), or a published
   `ghcr.io/<owner>/rocketpod:<version>` in `ROCKETPOD_IMAGE`.
2. **Settings.** `cp deploy/compose.env.example .env` at the repository root (check it is ignored),
   then fill it from the user's answers. Generate `OAUTH_ENCRYPTION_KEY` and replace the default
   `POSTGRES_PASSWORD` / `STORAGE_*` credentials for anything reachable from another machine.
3. **The origin.** `APP_URL` must be what people type. Over plain http the `__Host-session` cookie
   only works on `localhost`; anywhere else there must be TLS in front and
   `TRUSTED_PROXY_HOPS=1`. Never leave `APP_ENV=development` on a reachable host (it enables
   password-less dev-login).
4. **Run.** `docker compose up -d --build` (add `-f deploy/compose.single.yml` for one process).
   Then verify, quoting each result:
   ```bash
   docker compose ps                                  # migrate exited 0; web + worker healthy
   curl -fsS localhost:${WEB_PORT:-3001}/readyz        # {"status":"ready"}
   docker compose logs web | grep -i "magic link"     # the first admin's sign-in link (no RESEND key)
   ```
5. **Managed services instead:** set `DATABASE_URL` / `STORAGE_*` in `.env` and remove `postgres` /
   `s3` and their `depends_on` from the user's copy of `docker-compose.yml`.

## 2. Helm

1. **Image.** A published tag is the norm. Building and pushing one is a user decision (see the
   constraints) — the release workflow (`.github/workflows/image.yml`) pushes on a version tag.
2. **Values.** Write `deploy/values.local.yaml` (ignored) with `image.tag`, `config.APP_URL`, the
   `STORAGE_*` endpoint and bucket, ingress host/class/TLS and replica counts. Secrets go in a
   Secret the user manages — recommend `existingSecret` (External Secrets, Sealed Secrets, Vault)
   over inline `secrets:`; list the keys from the checklist below, never their values.
3. **Render and lint locally** — no cluster needed. If `helm` is not installed, use the image:
   ```bash
   docker run --rm -v "$PWD/deploy:/deploy" -w /deploy alpine/helm:3.16.4 \
     lint helm/rocketpod -f values.local.yaml
   docker run --rm -v "$PWD/deploy:/deploy" -w /deploy alpine/helm:3.16.4 \
     template rocketpod helm/rocketpod -f values.local.yaml > /tmp/rocketpod.yaml
   ```
   Read the render back: the migrate Job is a `pre-install,pre-upgrade` hook, `web` has readiness
   `/readyz`, the Ingress keeps WebSocket upgrades (`/ws`) — raise the nginx proxy timeouts per
   `docs/DEPLOY.md`.
4. **Install** — only after `AskUserQuestion` confirms the kube context (`kubectl config
   current-context`, quoted back to them) and the namespace:
   `helm upgrade --install rocketpod deploy/helm/rocketpod -n <ns> --create-namespace -f deploy/values.local.yaml`.
   Then `kubectl -n <ns> get pods`, the migrate Job's logs, and `/readyz` through the Ingress.

## Secrets checklist

Walk it as a table of **set / missing / not needed** — never values:

| Key | Needed for |
|---|---|
| `DATABASE_URL` | everything (required; the owner role — migrate creates `vector` if allowed) |
| `DATABASE_LISTEN_URL` | realtime when `DATABASE_URL` goes through PgBouncer in transaction mode |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | uploads, documents, avatars |
| `OAUTH_ENCRYPTION_KEY` (32+ chars) | OAuth/OIDC sign-in and tenant AI keys at rest |
| `ANTHROPIC_API_KEY` or `AI_API_KEY` (+ `AI_BASE_URL`/`AI_MODEL`) | chat and agents |
| `EMBEDDINGS_API_KEY` (+ `EMBEDDINGS_BASE_URL`/`EMBEDDINGS_MODEL`, 1024-dim) | knowledge uploads and search |
| `RESEND_API_KEY` | delivering magic links and invitations (otherwise logged — magic links by `web`, queued invitations by `worker`) |
| `GOOGLE_*`, `MICROSOFT_*`, `OIDC_CLIENT_SECRET` | the matching sign-in buttons |
| `TYPESAFE_API_KEY`, `LANGFUSE_*`, `OTEL_EXPORTER_OTLP_HEADERS` | optional: Jev decisions, trace export |

## End of turn

End with `AskUserQuestion`, not a paragraph. The choices after a deploy are: **sign in as the first
admin** (the magic link from the `web` log or email), **set up email** (`RESEND_API_KEY`),
**add AI keys**, or **wire tracing** (`/rp-traces`). After a dry run (render only), the choice is
whether to install now.
