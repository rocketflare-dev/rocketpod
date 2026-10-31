/**
 * The Labs Access token claims contract (`OIDC_PRESET=labs`). Labs Access's Pre Token Lambda
 * writes these into the id_token of every sign-in, filtered to the orgs granted the requesting app
 * client. The SHAPE is copied from Labs Access's own `LabsClaimsSchema`
 * (labs-access `packages/shared/src/claims.ts`) rather than depended on: a kit app never imports
 * the issuer's code, and an additive change there keeps `labs_v`.
 *
 * The server trusts these only from an id_token it verified itself (`iss` = the pool, `aud` = its
 * client, `exp`, `nonce` — `auth/providers/oidc.ts`).
 */
import { z } from 'zod'

/** At most this many orgs arrive in `labs_orgs` (Labs Access cuts the list there). */
export const LABS_ORGS_MAX = 50

/**
 * A person's role in a Labs org. `nearform_admin` / `nearform_staff` are Nearform's, the others a
 * client's.
 */
export const labsOrgRoleSchema = z.enum([
  'nearform_admin',
  'nearform_staff',
  'client_admin',
  'client_member',
])
export type LabsOrgRole = z.infer<typeof labsOrgRoleSchema>

/** One org granted the requesting app, with the person's role in it. */
export const labsOrgClaimSchema = z.object({
  /** The org's stable id — the app's `tenants.external_org_id`. */
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  role: labsOrgRoleSchema,
})
export type LabsOrgClaim = z.infer<typeof labsOrgClaimSchema>

export const labsClaimsSchema = z.object({
  labs_v: z.number().int().min(1),
  /** The person's Labs Access id, stable across IdP changes. */
  labs_person: z.string().min(1),
  /** A member of the Nearform org. */
  labs_staff: z.boolean(),
  /** Holds `nearform_admin` → the app's global admin. */
  labs_platform_admin: z.boolean(),
  /** The orgs whose grants include this app's client. */
  labs_orgs: z.array(labsOrgClaimSchema).max(LABS_ORGS_MAX),
})
export type LabsClaims = z.infer<typeof labsClaimsSchema>
