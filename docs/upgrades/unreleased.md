---
version: unreleased
previous: 0.45.1
date: null
breaking: true
migrations: ["pending_uploads (new tenant table + RLS policy admitting rocketpod_system; user_id nullable, ON DELETE SET NULL) — 0020_kit-pending-uploads"]
areas: [api, cli, db, shared, ui, plugins, config, deploy, docs]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Uploads move to `/api/uploads` (presign, PUT, confirm): a presigned S3 `PUT` when `STORAGE_DIRECT_UPLOADS` is on, the server's own streamed upload URL otherwise; plugins gain `uploadTargets`, and `uploadPaths` / `uploadLimits` keep working, deprecated.

- `POST /api/uploads` and `POST /api/uploads/:id/confirm` (new): the presign runs every check the old routes ran (401/403, 413, 415, 400 `file_empty`, 503 `storage_not_configured` / `conversion_not_configured`); confirm answers what they answered (a `files` row 201; a document 201, or 200 `deduplicated: true`). Design: `docs/CONCEPTS.md` §6.
- Removed: multipart `POST /api/files?scope=` and `POST /api/ai/documents/upload`, with `uploadBodyLimit`, `UPLOAD_PATHS` / `isUploadPath` and `uploadQuerySchema` (`@rocketpod/shared/files`). No core route takes a body above 1 MB.
- `apiBodyLimit` takes one options object (`{ overrides, serverUpload, pluginUploadPaths, uploadLimits }`) instead of positional arguments.
- Confirm errors (new codes): 404 for another tenant's or person's id or a second confirm, 410 `upload_expired`, 400 `upload_missing`, 400 `upload_mismatch` (object deleted). Unknown target → 400 `unknown_upload_target`.
- Config (new): `STORAGE_DIRECT_UPLOADS` (`false`). `true` answers a presigned `PutObject` (`@aws-sdk/s3-request-presigner`, pinned with `client-s3`) signed with `Content-Type`, `Content-Length` and `If-None-Match: *`; it needs an `https` store endpoint and a bucket CORS rule (`docs/DEPLOY.md` § Direct uploads).
- Off, `POST /api/uploads` hands out `PUT /api/upload-content/:id?token=` (a 256-bit token stored hashed, compared in constant time, spent once confirmed), which streams the body to the store with a conditional write, up to `MAX_SERVER_UPLOAD_BYTES` (50 MiB; larger → 413 `details.directUploads: false`).
- `StorageService` (platform seam): `put` / `putStream` take `ifAbsent` (`StorageObjectExistsError` when the key exists, the multipart complete included) and `presignPut(key, options)` is new. Under `STORAGE_TENANT_FENCE=on` a URL is signed with the tenant's STS session, renewed first when it would expire before the URL.
- `pending_uploads` table (new). The nightly `prunePendingUploads` task (`0 4 * * *`) deletes unconfirmed uploads with their objects, and a confirmed core upload's object no `files` row records.
- `pending_uploads.user_id` is nullable, `ON DELETE SET NULL`: the row outlives a deleted person, can be neither `PUT` nor confirmed, and the prune still deletes its object.
- Dedupe of a document now happens at confirm. A duplicate's bytes are stored, then deleted.
- Plugin seam: `ServerPlugin.uploadTargets` (`PluginUploadTarget` from `@/plugins/api`, `docs/CONCEPTS.md` §16) is new, with a REQUIRED `permission: { action, subject }` the host checks before `prepare`. `confirm` receives the tenant's `storage`.
- A plugin upload key must sit under `tenants/<tenantId>/<pluginId>/` and name the upload id (else 500 `upload_key_invalid`); no URL is handed out for a key that already holds an object (409 `upload_key_exists`).
- UI: `api.upload(target, file, { fields, schema })` replaces `api.upload(url, formData, …)`. CLI: `ApiClient.upload(target, { name, contentType, bytes }, { fields, schema })` replaces `postForm`.
- Fix: a document upload now keeps its `visibility` and `groupIds`, which the old form post dropped.
- Fix: `scripts/detach.sh` no longer exits 141 with no message on a clone with a long history (`head -1` closed the pipe on `git log` under `pipefail`).

## How to apply

1. Port `apps/web/src/db/schema/pending-uploads.ts` and its export from `apps/web/src/db/schema/index.ts`, run `pnpm db:generate --name kit-pending-uploads`, review the SQL (table, RLS policy naming `rocketpod_app` and `rocketpod_system`, the `(tenant_id, expires_at)` index, `user_id` nullable with `ON DELETE set null`), then run `pnpm db:migrate`.
2. Add `STORAGE_DIRECT_UPLOADS=false` to `apps/web/.env`, and to every deployment's environment (the chart's `config`, the compose `.env`) if it overrides storage settings.
3. Optional, for direct uploads: point `STORAGE_ENDPOINT` at an `https` URL the browser can reach, add a CORS rule allowing `PUT` with `content-type` and `if-none-match` from the app's origin to the bucket, then set `STORAGE_DIRECT_UPLOADS=true` (`docs/DEPLOY.md` § Direct uploads).
4. With `STORAGE_DIRECT_UPLOADS` off, raise the ingress's `nginx.ingress.kubernetes.io/proxy-body-size` to the largest upload target plus a margin (`"6m"` for the core targets, `"51m"` for a 50 MiB plugin target).
5. Replace every app call of `api.upload(url, formData, options)` with `api.upload('<target>', file, { fields, ...options })`. The core targets are `avatars`, `uploads` and `documents`.
6. Replace every CLI call of `client.postForm(path, form)` with `client.upload('<target>', { name, contentType, bytes }, { fields, schema })`.
7. Replace any call of `apiBodyLimit(overrides, uploadPaths, uploadLimits)` in app code with `apiBodyLimit({ overrides, pluginUploadPaths, uploadLimits })`.
8. Replace any app test that posted `FormData` to an upload route with `directUpload(env, cookie, target, file, fields)` from `apps/web/tests/helpers/uploads.ts`.
9. Add `presignPut` to any `StorageService` the app implements itself (a test double, a wrapper), and honour `ifAbsent` in its `put` / `putStream`.
10. Leave each installed plugin's `uploadPaths` / `uploadLimits` as they are: both still work. A plugin moves to an `uploadTargets` entry in its own release (`id: '<plugin id>.<name>'`, `permission`, `maxBytes`, `prepare` for further checks, `confirm` for what the route did once the bytes were stored).
11. Plugin authors: a `prepare` that answers its own `key` must build it under `tenants/<tenantId>/<pluginId>/` with the `uploadId` in it, or omit `key` for that default.
12. Plugin authors: a plugin that deletes a confirmed upload's object within 10 minutes of the presign, while its presigned URL lives, owns removing anything written to that key again; the prune covers core targets only (`docs/CONCEPTS.md` §6, known gaps).

## Conflicts to expect

- `apps/web/src/api/middleware/body-limit.ts` → core upload caps removed, `apiBodyLimit` takes an options object → take the kit's file, then re-add any app cap.
- `apps/web/src/api/routes/files.ts`, `routes/ai-documents.ts` → the multipart `POST` handlers removed → move an app's custom upload checks into the target's `prepare` in `services/uploads/targets.ts`.
- `apps/web/src/platform/types.ts`, `apps/web/src/node/storage.ts` → `presignPut` and `ifAbsent` added → take the kit's code, then re-add local changes.
- `apps/web/src/plugins/types.ts` → `uploadTargets` added beside the deprecated `uploadPaths` / `uploadLimits` → keep all three.
- `apps/web/src/ui/lib/api-client.ts` → `FormData` branch removed, `upload` re-signed → take the kit's file.
- `apps/web/tests/mocks/bindings.ts` → `MemoryStorage` honours `ifAbsent` and records `presignPut` → take the kit's file, then re-add any local stub methods.

## Verify

1. `pnpm gate` passes.
2. `pnpm test api apps/web/tests/api/uploads.test.ts apps/web/tests/api/uploads-direct.test.ts` passes, including the permission, key-rule, existing-object, spent-URL, concurrent-`PUT`, unclaimed-confirm, deleted-person and gateway-held signed-header cases.
3. `psql "$DATABASE_URL" -c '\d pending_uploads'` shows `user_id` nullable with `ON DELETE SET NULL`.
4. `curl -s -X POST <app-url>/api/uploads -H 'Authorization: Bearer <key>' -H 'Content-Type: application/json' -d '{"target":"uploads","name":"a.txt","contentType":"text/plain","size":5}'` answers 201 with a `url` on the store's endpoint when `STORAGE_DIRECT_UPLOADS=true`, else on the app's own `/api/upload-content/`.
5. Uploading an avatar on the Profile page shows the new image.
