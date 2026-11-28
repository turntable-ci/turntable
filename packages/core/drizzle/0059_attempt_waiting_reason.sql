ALTER TABLE `job_attempts` ADD `waiting_reason` text;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `waiting_since` integer;--> statement-breakpoint
ALTER TABLE `job_attempts` ADD `waited_ms` text;