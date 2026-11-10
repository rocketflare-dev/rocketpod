/**
 * `pnpm web agent:replay` runs the whole agent registry through tsx, outside the server — so an
 * import the registry gains that only resolves inside the bundle (or a script that no longer
 * loads) breaks it where no type check looks. Loading the script is the proof. `--help` exits
 * before any database is touched.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB = fileURLToPath(new URL('../..', import.meta.url))

describe('agent:replay script', () => {
  it('imports under Node and prints its usage', () => {
    const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/agent-replay.ts', '--help'], {
      cwd: WEB,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    })
    expect(run.stderr).toContain('usage: pnpm web agent:replay')
    expect(run.stderr).not.toMatch(/ERR_/)
    expect(run.status).toBe(2)
  })
})
