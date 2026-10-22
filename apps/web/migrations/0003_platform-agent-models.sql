CREATE TABLE "platform_agent_models" (
	"prompt_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"model" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_agent_models" ADD CONSTRAINT "platform_agent_models_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;