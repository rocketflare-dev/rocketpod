/**
 * The `Range` request header, for the routes that stream an object through the server
 * (`GET /api/files/:id`). ONE range only, in the three forms HTTP names (RFC 9110 §14.1.2):
 * `bytes=a-b`, `bytes=a-` and `bytes=-n`.
 *
 * Anything else — a missing header, another unit, a malformed spec, `b < a`, or several ranges — is
 * IGNORED (null): the route answers 200 with the whole object, which RFC 9110 §14.2 allows ("a
 * server MAY ignore the Range header field"), and every browser's media stack handles. Whether a
 * well-formed range can be satisfied is the store's answer (`StorageRangeNotSatisfiableError` →
 * 416), because only the store knows the object's length.
 */
import type { StorageRange } from '../../../platform/types'

/** Digits beyond this are not a byte offset any object here could have. */
const MAX_DIGITS = 15

export function parseByteRange(header: string | null | undefined): StorageRange | null {
  if (!header) return null
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!match) return null
  const [, from = '', to = ''] = match
  if (from.length > MAX_DIGITS || to.length > MAX_DIGITS) return null
  if (from === '' && to === '') return null
  if (from === '') return { suffix: Number(to) }
  const start = Number(from)
  if (to === '') return { start }
  const end = Number(to)
  return end < start ? null : { start, end }
}
