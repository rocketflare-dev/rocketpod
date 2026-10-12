/**
 * The Worker's bindings, as `wrangler types` generates them (`Cloudflare.Env` in
 * `worker-configuration.d.ts`), plus `HYPERDRIVE`, which exists only under
 * `DATABASE_DRIVER = "postgres"` (D35): the kit's tomls ship without `[[hyperdrive]]`, so
 * `wrangler types` omits it while a copy on postgres has it. Only this directory and the Worker
 * entry (`src/worker.ts` and the DO/Workflow classes it exports) may name this type.
 */
declare global {
  namespace Cloudflare {
    /**
     * `AI` is declared here as well as by `wrangler types` so the type exists in BOTH toml states:
     * `pnpm bootstrap --offline` comments the `[ai]` block out of both tomls, the regenerated
     * `worker-configuration.d.ts` then has no `AI`, and the adapter below would fail to compile.
     * With `[ai]` present the two declarations are identical and merge.
     */
    interface Env {
      AI: Ai
    }
  }
}

export type CloudflareBindings = Cloudflare.Env & { HYPERDRIVE?: Hyperdrive }
