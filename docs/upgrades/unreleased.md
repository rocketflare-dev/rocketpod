---
version: unreleased
previous: 0.45.0
date: null
breaking: false
migrations: []
areas: [config, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

A release workflow for AWS ECS on infrastructure managed elsewhere: a version tag copies the image to ECR, syncs the UI assets, runs migrate on Fargate and rolls web and worker, configured by one `AWS_DEPLOY_CONFIG` variable.

- A release workflow for AWS ECS whose infrastructure is managed elsewhere: `.github/workflows/deploy-aws.yml` (`workflow_call` and `workflow_dispatch`, input `version`, optional `asset_dirs`, default `assets`), called by a new `deploy-aws` job in `image.yml` after `publish` on a version tag, only when the repository variable `AWS_DEPLOY_CONFIG` is set. That one JSON variable carries twelve keys (`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SUBNETS`, `ECS_SECURITY_GROUP`, `ECS_WEB_SERVICE`, `ECS_WORKER_SERVICE`, `ECS_FAMILY_PREFIX`, `ASSETS_BUCKET`, `IMAGE_PARAMETER`, `LOG_GROUP`), checked in the first step. The job assumes a role over OIDC in the `production` environment, copies the image GHCR → ECR (skipped when the tag exists), syncs `dist/ui/assets` to the assets bucket as immutable (never `--delete`), writes the SSM image parameter, registers `<prefix>-web|worker|migrate` revisions with only the image swapped, runs migrate on Fargate (failing with its last log lines), then rolls web and worker and checks they are stable on the new revisions. The kit ships no infrastructure. Runbook: `docs/DEPLOY.md` § AWS ECS (infrastructure managed elsewhere).

## How to apply

1. `.github/workflows/**` is a `manual` surface: `pnpm kit:upgrade` does not write these files, it shows their diff in `reference/` for you to apply what you want. To take the AWS ECS release, copy `.github/workflows/deploy-aws.yml` in whole, replacing `rocketpod` in its `GHCR_IMAGE` with the image name your `image.yml` publishes, and add the `deploy-aws` job at the end of your `image.yml`, with `needs:` naming your own CI-wait, chart and publish jobs. A copy whose `image.yml` already has a deploy job keeps its own and skips this.
2. Nothing deploys until you set `AWS_DEPLOY_CONFIG`. To use it, follow `docs/DEPLOY.md` § AWS ECS: create the `production` environment, have your infrastructure's deploy role trust `repo:<owner>/<repo>:environment:production`, then set the variable to the infrastructure's `deploy` output as JSON. From then on every version tag is a production deploy.

## Conflicts to expect

- `.github/workflows/image.yml` → a `deploy-aws` job after `publish` and two header comment lines → keep the app's jobs; point the new job's `needs:` at the app's own job names.

## Verify

1. `actionlint .github/workflows/deploy-aws.yml .github/workflows/image.yml` reports nothing.
2. With `AWS_DEPLOY_CONFIG` unset, a version tag's `image.yml` run shows `Deploy (AWS ECS)` skipped.
3. `pnpm gate` prints `✔ pnpm gate passed`.
