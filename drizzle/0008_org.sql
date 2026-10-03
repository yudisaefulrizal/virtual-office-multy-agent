CREATE TABLE `departments` (
	`id` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`color` varchar(9) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_by` varchar(80) NOT NULL DEFAULT 'system',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `departments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `roles` ADD `plannable` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `roles` ADD `task_kind` varchar(16);--> statement-breakpoint
ALTER TABLE `roles` ADD `description` text;--> statement-breakpoint
ALTER TABLE `roles` ADD `created_by` varchar(80) DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `queued_at` datetime(3);