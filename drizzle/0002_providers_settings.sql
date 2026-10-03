CREATE TABLE `providers` (
	`id` varchar(32) NOT NULL,
	`api_key_enc` text NOT NULL,
	`api_key_last4` varchar(8) NOT NULL,
	`default_model` varchar(128) NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
