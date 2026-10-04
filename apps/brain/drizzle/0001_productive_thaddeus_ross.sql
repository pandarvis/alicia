CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`conversation_id` text,
	`import_key` text,
	`embedding` blob NOT NULL,
	`embedding_model` text NOT NULL,
	`recall_count` integer DEFAULT 0 NOT NULL,
	`last_recalled_at` integer,
	`forgotten_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_import_key_unique` ON `memories` (`import_key`);--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`scope`,`forgotten_at`);--> statement-breakpoint
CREATE INDEX `conversations_person_updated_idx` ON `conversations` (`person_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `messages_conversation_created_idx` ON `messages` (`conversation_id`,`created_at`);