ALTER TABLE "job_attempts" ADD COLUMN "waiting_reason" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "waiting_since" bigint;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "waited_ms" text;