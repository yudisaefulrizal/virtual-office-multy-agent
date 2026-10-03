ALTER TABLE `agents` ADD `tenure` varchar(16) DEFAULT 'permanent' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `temp_objective_id` varchar(36);--> statement-breakpoint
ALTER TABLE `agents` ADD `status_changed_at` datetime(3);