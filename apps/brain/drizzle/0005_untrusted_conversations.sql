ALTER TABLE `conversations` ADD `untrusted_at` integer;--> statement-breakpoint
-- Conversations that already let outside content in (an attachment, a web page or search) start untrusted:
-- that content is still in their session, their resume prompt or what was remembered.
UPDATE `conversations` SET `untrusted_at` = `created_at` WHERE `id` IN (SELECT `conversation_id` FROM `attachments` WHERE `conversation_id` IS NOT NULL) OR `id` IN (SELECT `conversation_id` FROM `turn_log` WHERE `tools` LIKE '%"tool":"WebFetch"%' OR `tools` LIKE '%"tool":"WebSearch"%');
