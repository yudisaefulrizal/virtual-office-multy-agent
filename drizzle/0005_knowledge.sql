CREATE TABLE `knowledge` (
	`id` varchar(36) NOT NULL,
	`topic` varchar(255) NOT NULL,
	`topic_key` varchar(255) NOT NULL,
	`category` varchar(32) NOT NULL,
	`content` text NOT NULL,
	`sources` json NOT NULL DEFAULT (JSON_ARRAY()),
	`confidence` varchar(16) NOT NULL,
	`researched_at` datetime(3) NOT NULL,
	`last_verified_at` datetime(3) NOT NULL,
	`recheck_after` datetime(3) NOT NULL,
	`created_by_task_id` varchar(36),
	`objective_id` varchar(36),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `knowledge_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_topic_key_idx` UNIQUE(`topic_key`)
);
--> statement-breakpoint
CREATE INDEX `knowledge_category_idx` ON `knowledge` (`category`);