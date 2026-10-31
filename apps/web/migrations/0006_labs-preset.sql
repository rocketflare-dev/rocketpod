ALTER TABLE "tenant_users" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "external_org_id" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "global_admin_source" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_external_org_id_unique" UNIQUE("external_org_id");