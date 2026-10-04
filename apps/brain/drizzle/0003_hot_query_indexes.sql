CREATE INDEX `memories_conversation_idx` ON `memories` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `turn_log_conversation_idx` ON `turn_log` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `turn_log_created_idx` ON `turn_log` (`created_at`);