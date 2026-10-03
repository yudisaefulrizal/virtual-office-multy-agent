CREATE TABLE `schedules` (
	`id` varchar(36) NOT NULL,
	`objective_id` varchar(36) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`time_of_day` varchar(5),
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Jakarta',
	`interval_hours` int,
	`enabled` boolean NOT NULL DEFAULT true,
	`next_run_at` datetime(3) NOT NULL,
	`last_run_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `schedules_objective_id_unique` UNIQUE(`objective_id`)
);
--> statement-breakpoint
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_objective_id_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON DELETE no action ON UPDATE no action;