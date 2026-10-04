CREATE TABLE `image_generations` (
	`id` varchar(36) NOT NULL,
	`model` varchar(128) NOT NULL,
	`status` varchar(16) NOT NULL,
	`cost_usd_micros` bigint NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `image_generations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `image_generations_created` ON `image_generations` (`created_at`);