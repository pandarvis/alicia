CREATE TABLE `appareils` (
	`id` text PRIMARY KEY NOT NULL,
	`personne_id` text NOT NULL,
	`nom` text NOT NULL,
	`jeton_hache` text NOT NULL,
	`cree_le` integer NOT NULL,
	`vu_le` integer,
	`revoque_le` integer,
	FOREIGN KEY (`personne_id`) REFERENCES `personnes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appareils_jeton_hache_unique` ON `appareils` (`jeton_hache`);--> statement-breakpoint
CREATE TABLE `codes_appairage` (
	`code_hache` text PRIMARY KEY NOT NULL,
	`personne_id` text NOT NULL,
	`expire_le` integer NOT NULL,
	FOREIGN KEY (`personne_id`) REFERENCES `personnes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`personne_id` text NOT NULL,
	`titre` text NOT NULL,
	`session_id` text,
	`cree_le` integer NOT NULL,
	`maj_le` integer NOT NULL,
	FOREIGN KEY (`personne_id`) REFERENCES `personnes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `journal` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`modele` text NOT NULL,
	`tokens_entree` integer NOT NULL,
	`tokens_sortie` integer NOT NULL,
	`duree_ms` integer NOT NULL,
	`outils` text NOT NULL,
	`erreur` text,
	`cree_le` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`texte` text NOT NULL,
	`cree_le` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `personnes` (
	`id` text PRIMARY KEY NOT NULL,
	`nom` text NOT NULL
);
