DROP INDEX "agent_runs_active_exclusive_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "concurrency_key" text;--> statement-breakpoint
-- Every agent was exclusive per tenant until now: active rows keep that slot.
UPDATE "agent_runs" SET "concurrency_key" = '' WHERE "status" IN ('queued', 'running', 'awaiting_input');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_exclusive_idx" ON "agent_runs" USING btree ("tenant_id","agent_key","concurrency_key") WHERE "agent_runs"."status" IN ('queued', 'running', 'awaiting_input') AND "agent_runs"."concurrency_key" IS NOT NULL;