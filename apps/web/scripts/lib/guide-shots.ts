/**
 * The pure half of `pnpm web guide:shots`: the screenshot manifest, route placeholders, which
 * entries are stale, and whether a fresh shot differs enough from the committed one to rewrite
 * it. The browser and git live in `scripts/guide-shots.ts`.
 */
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/** Repo-relative, like the `sources` globs and git's paths. */
export const MANIFEST_PATH = 'apps/web/content/guide/screenshots.yaml'
export const IMAGES_DIR = 'apps/web/content/guide/images'

const stepSchema = z.union([
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ waitFor: z.string().min(1) }).strict(),
  /** A key chord for the page, Playwright's spelling (`Meta+k`, `Escape`). */
  z.object({ press: z.string().min(1) }).strict(),
  /** Type into the first element matching `selector`. */
  z.object({ fill: z.object({ selector: z.string().min(1), text: z.string() }).strict() }).strict(),
])
export type ShotStep = z.infer<typeof stepSchema>

export const shotEntrySchema = z
  .object({
    /** Becomes `images/<id>.png` and the `shot:<id>` reference in a page. */
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case'),
    /** A UI path; `{name}` placeholders resolve through `routeValues` in the script. */
    route: z.string().startsWith('/'),
    steps: z.array(stepSchema).default([]),
    /** The element to capture; omitted = the viewport. */
    crop: z.string().min(1).optional(),
    theme: z.enum(['light', 'dark']).default('light'),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .default({ width: 1440, height: 900 }),
    /** UI code that, when changed, makes this shot stale. */
    sources: z.array(z.string().min(1)).min(1),
  })
  .strict()
export type ShotEntry = z.infer<typeof shotEntrySchema>

export const manifestSchema = z
  .object({ shots: z.array(shotEntrySchema) })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>()
    for (const [i, s] of m.shots.entries()) {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: 'custom', path: ['shots', i, 'id'], message: `duplicate id ${s.id}` })
      }
      seen.add(s.id)
    }
  })

export function parseManifest(text: string): ShotEntry[] {
  return manifestSchema.parse(parseYaml(text) ?? { shots: [] }).shots
}

/** Every `{name}` placeholder the selected entries use, sorted. */
export function routePlaceholders(entries: readonly ShotEntry[]): string[] {
  const names = new Set<string>()
  for (const e of entries) for (const m of e.route.matchAll(/\{([^}]+)\}/g)) names.add(m[1] ?? '')
  return [...names].sort()
}

/**
 * Fill a route's `{name}` placeholders from `values` (what the script looked up on the dev server
 * — core defines none; an app adds its own lookups to `routeValues` in `scripts/guide-shots.ts`).
 * An unknown placeholder, or one the workspace cannot fill (`null`), throws rather than shooting a
 * 404.
 */
export function resolveRoute(route: string, values: Readonly<Record<string, string | null>>) {
  return route.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(
        `Unknown route placeholder {${key}} in ${route} — add a lookup for it to routeValues (scripts/guide-shots.ts)`
      )
    }
    const value = values[key]
    if (value === null || value === undefined) {
      throw new Error(`${route} needs {${key}}, and this workspace has none — seed one first`)
    }
    return encodeURIComponent(value)
  })
}

export function imagePathFor(id: string): string {
  return `${IMAGES_DIR}/${id}.png`
}

/** What `--stale` needs from git. */
export interface ShotsGit {
  /** The last commit that touched `file`, or null if it was never committed. */
  lastCommitOf(file: string): string | null
  /** Files changed in `sha..HEAD` plus the working tree and untracked files. */
  changedSince(sha: string): string[]
}

/** An entry is stale when its image was never committed, or a source changed since it was. */
export function staleEntries(entries: ShotEntry[], git: ShotsGit): ShotEntry[] {
  return entries.filter(entry => {
    const sha = git.lastCommitOf(imagePathFor(entry.id))
    if (!sha) return true
    return git
      .changedSince(sha)
      .some(file => entry.sources.some(glob => path.matchesGlob(file, glob)))
  })
}

/**
 * Below this share of differing pixels, a fresh shot is "unchanged" and the committed image is
 * left alone — anti-aliasing and sub-pixel text rendering wobble by a handful of pixels.
 */
export const DIFF_RATIO_THRESHOLD = 0.001

export interface CompareResult {
  changed: boolean
  /** Share of pixels that differ; 1 when the dimensions differ or there is no baseline. */
  ratio: number
  reason: 'new' | 'size' | 'pixels' | 'same'
}

export function compareShots(baseline: Buffer | null, fresh: Buffer): CompareResult {
  if (!baseline) return { changed: true, ratio: 1, reason: 'new' }
  const a = PNG.sync.read(baseline)
  const b = PNG.sync.read(fresh)
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, ratio: 1, reason: 'size' }
  }
  const differing = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 })
  const ratio = differing / (a.width * a.height)
  return ratio > DIFF_RATIO_THRESHOLD
    ? { changed: true, ratio, reason: 'pixels' }
    : { changed: false, ratio, reason: 'same' }
}

/**
 * Injected into every page: no animation or transition, no caret blink, no smooth scroll — so two
 * shots of the same screen are the same pixels. It also hides the dev server's own chrome, which
 * no reader's screen has: the TanStack Query Devtools toggle (`tsqd-*`, dev builds only) and the
 * header's environment badge ("Dev", `EnvironmentBadge`, the only `[data-env]`).
 */
export const FREEZE_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}
.tsqd-open-btn-container, [data-env] { display: none !important; }`

/**
 * The page-side init script, as a STRING: tsx compiles the script with esbuild's keepNames, so a
 * serialised function carries `__name(...)` calls the page does not define and throws before it
 * does anything (the freeze CSS then never reaches a shot). It runs before the document is parsed,
 * so the style waits for the parsed head.
 */
export function freezeInitScript(theme: string): string {
  return `localStorage.setItem('theme', ${JSON.stringify(theme)});
document.addEventListener('DOMContentLoaded', function () {
  var style = document.createElement('style');
  style.textContent = ${JSON.stringify(FREEZE_CSS)};
  document.head.appendChild(style);
});`
}
