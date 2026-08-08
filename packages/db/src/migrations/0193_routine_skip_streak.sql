ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "skip_reason" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "consecutive_skip_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "consecutive_skip_reason" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "consecutive_skip_since" timestamp with time zone;
