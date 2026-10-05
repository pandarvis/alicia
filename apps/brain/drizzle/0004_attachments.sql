CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`extension` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachments_conversation_idx` ON `attachments` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `attachments_person_idx` ON `attachments` (`person_id`,`conversation_id`);