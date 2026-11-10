ALTER TABLE "agent_runs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_status_idx" ON "agent_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_batch_idx" ON "agent_runs" USING btree ("tenant_id","batch_id") WHERE "agent_runs"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_usage_tenant_run_idx" ON "ai_usage" USING btree ("tenant_id","agent_run_id") WHERE "ai_usage"."agent_run_id" IS NOT NULL;