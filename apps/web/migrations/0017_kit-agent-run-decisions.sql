CREATE TABLE "agent_run_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"model" text NOT NULL,
	"request" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"questions_hash" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_run_decisions" ADD CONSTRAINT "agent_run_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_decisions" ADD CONSTRAINT "agent_run_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_decisions_run_key_idx" ON "agent_run_decisions" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "agent_run_decisions_tenant_created_idx" ON "agent_run_decisions" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_run_decisions_tenant_hash_idx" ON "agent_run_decisions" USING btree ("tenant_id","questions_hash");--> statement-breakpoint
CREATE POLICY "agent_run_decisions_tenant_isolation" ON "agent_run_decisions" AS PERMISSIVE FOR ALL TO "rocketflare_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);