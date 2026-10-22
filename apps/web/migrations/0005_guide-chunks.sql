CREATE TABLE "guide_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_path" text NOT NULL,
	"part" text NOT NULL,
	"audience" text NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"content_hash" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "guide_chunks_page_idx" ON "guide_chunks" USING btree ("page_path");--> statement-breakpoint
CREATE INDEX "guide_chunks_embedding_idx" ON "guide_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "guide_chunks_search_vector_idx" ON "guide_chunks" USING gin ("search_vector");