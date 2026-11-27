/**
 * No authed `/api/*` path takes a body above the 1 MB cap any more — the old multipart paths
 * included, which once let 10 MB + 64 KB through. The one larger door is the server's own upload
 * URL (what `POST /api/uploads` hands out with `STORAGE_DIRECT_UPLOADS` off): the largest target's
 * `maxBytes`, within `MAX_SERVER_UPLOAD_BYTES`.
 */
import { describe, expect, it } from 'vitest'
import { MAX_JSON_BODY_BYTES } from '@/api/middleware/body-limit'
import { MAX_SERVER_UPLOAD_BYTES, serverUploadMaxBytes } from '@/api/services/uploads/service'
import { uploadTargets } from '@/api/services/uploads/targets'
import {
  createTestSession,
  createTestTenantWithUser,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { json, request } from '../../helpers/request'
import { createTestEnv } from '../../mocks/bindings'

const db = setupTestDatabase()

describe('upload bodies are capped', () => {
  it('the former multipart paths refuse a body above the JSON cap with 413', async () => {
    const { user, tenant } = await createTestTenantWithUser(db, 'owner')
    const cookie = sessionCookieHeader(await createTestSession(db, user.id, tenant.id))
    const body = new Uint8Array(MAX_JSON_BODY_BYTES + 1)
    for (const path of ['/api/files?scope=avatars', '/api/ai/documents/upload', '/api/uploads']) {
      const res = await request(
        path,
        {
          method: 'POST',
          headers: {
            ...cookie,
            'Content-Type': 'multipart/form-data; boundary=x',
            'Content-Length': String(body.byteLength),
          },
          body,
        },
        { env: createTestEnv() }
      )
      expect(res.status, path).toBe(413)
      expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
    }
  })

  it('the server upload URL refuses more than the largest target, within MAX_SERVER_UPLOAD_BYTES', async () => {
    const largest = Math.max(...[...uploadTargets().values()].map(t => t.maxBytes))
    const cap = Math.min(largest, MAX_SERVER_UPLOAD_BYTES)
    expect(serverUploadMaxBytes()).toBe(cap)
    const over = new Uint8Array(cap + 1)
    const res = await request(
      `/api/upload-content/${crypto.randomUUID()}?token=x`,
      { method: 'PUT', headers: { 'Content-Length': String(over.byteLength) }, body: over },
      { env: createTestEnv() }
    )
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ statusCode: 413, code: 'payload_too_large' })
  })
})
