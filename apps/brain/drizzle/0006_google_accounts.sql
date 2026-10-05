CREATE TABLE `google_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`email` text NOT NULL,
	`scopes` text NOT NULL,
	`refresh_token` blob NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_accounts_email_unique` ON `google_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `google_accounts_owner_idx` ON `google_accounts` (`owner`);