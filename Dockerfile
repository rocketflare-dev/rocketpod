# syntax=docker/dockerfile:1.7
#
# Rocketpod's one image (M7, docs/DEPLOY.md): the Hono API + React UI + background worker, and the
# migrate one-shot. `pnpm build` bundles the Node entry into `dist/server.js` and the migrate entry
# into `dist/migrate.js` (apps/web/scripts/build-server.mjs) — every dependency is inside the
# bundle, so the runtime stage carries no node_modules at all: Node, the two bundles, the built UI,
# the drizzle SQL and the Guide's content.
#
#   docker run IMAGE                  → web    (API + UI + /ws on :3001)
#   docker run IMAGE worker           → jobs, cron and agent runs
#   docker run IMAGE all              → both in one process (small installs)
#   docker run --entrypoint node IMAGE dist/migrate.js   → the migrate one-shot

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------------------- build
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable

# The manifests first, so a source-only change reuses the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/evals/package.json apps/evals/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @rocketpod/web...

COPY . .
ARG RELEASE_VERSION=dev
RUN pnpm --filter @rocketpod/web build

# -------------------------------------------------------------------------------------- runtime
# Alpine: the bundles are pure JavaScript (no native addons), so musl is fine. npm, npx, corepack
# and yarn are removed — the image runs `node` and nothing else installs anything.
FROM node:${NODE_VERSION}-alpine AS runtime
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    MIGRATIONS_DIR=/app/migrations
ARG RELEASE_VERSION=dev
ENV RELEASE_VERSION=${RELEASE_VERSION}

COPY --from=build --chown=node:node /repo/apps/web/dist/server.js /repo/apps/web/dist/migrate.js ./dist/
COPY --from=build --chown=node:node /repo/apps/web/dist/ui ./dist/ui
COPY --from=build --chown=node:node /repo/apps/web/migrations ./migrations
# The Guide's pages, images and committed vectors: read by the reader routes and chunked into
# `guide_chunks` at boot (`src/node/guide-content.ts` resolves `content/guide` under WORKDIR).
COPY --from=build --chown=node:node /repo/apps/web/content/guide ./content/guide

# The `node` user (uid 1000) from the base image; the app writes nothing to its filesystem.
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/server.js"]
CMD ["web"]
