/**
 * `/api/uploads`: the upload flow (`services/uploads/service.ts`). The client asks for a URL,
 * `PUT`s the file to it, then confirms:
 *
 *   POST /api/uploads              { target, name, contentType, size, fields? } → 201 the PUT URL;
 *                                  the target's 400/403/409/413/415/503 before any byte is stored
 *   POST /api/uploads/:id/confirm  → the target's answer (a `files` row 201, a document 201/200);
 *                                  404 unknown / another tenant's or person's / already confirmed,
 *                                  410 expired, 400 `upload_missing` / `upload_mismatch`
 *
 * The URL is a presigned S3 `PUT` when `STORAGE_DIRECT_UPLOADS` is on, so the bytes never come
 * here. Off, it is `serverUploadRouter` (`PUT /api/upload-content/:id?token=`), which streams the
 * body to the store under the same rules, up to `MAX_SERVER_UPLOAD_BYTES`. That router is mounted
 * outside the authed table: the token is its credential, as the signature is on S3's URL.
 */
import { createUploadRequestSchema } from '@rocketpod/shared/uploads'
import { confirmUpload, createUpload, receiveServerUpload } from '../services/uploads/service'
import { uuidParam } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const uploadsRouter = createRouter()

uploadsRouter.post('/', validate('json', createUploadRequestSchema), async c => {
  return c.json(await createUpload(c, c.req.valid('json')), 201)
})

uploadsRouter.post('/:id/confirm', async c => {
  const { status, body } = await confirmUpload(c, uuidParam(c, 'id'))
  return c.json(body as object, status)
})

export const serverUploadRouter = createRouter()

serverUploadRouter.put('/:id', async c => {
  await receiveServerUpload(c, uuidParam(c, 'id'))
  return c.body(null, 200)
})
