CREATE TABLE `instagram_media` (
	`account_id` varchar(64) NOT NULL,
	`media_id` varchar(64) NOT NULL,
	`caption` text,
	`media_type` varchar(24),
	`permalink` varchar(255),
	`media_url` text,
	`posted_at` datetime(3),
	`like_count` int,
	`comments_count` int,
	`first_seen_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`fetched_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `instagram_media_account_id_media_id_pk` PRIMARY KEY(`account_id`,`media_id`)
);
--> statement-breakpoint
CREATE TABLE `instagram_snapshots` (
	`id` varchar(36) NOT NULL,
	`account_id` varchar(64) NOT NULL,
	`username` varchar(64) NOT NULL,
	`followers` int NOT NULL,
	`following` int,
	`media_count` int,
	`views` int,
	`reach` int,
	`accounts_engaged` int,
	`total_interactions` int,
	`likes` int,
	`comments` int,
	`shares` int,
	`saves` int,
	`profile_views` int,
	`fetched_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `instagram_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `instagram_media_posted` ON `instagram_media` (`account_id`,`posted_at`);--> statement-breakpoint
CREATE INDEX `instagram_snapshots_account_time` ON `instagram_snapshots` (`account_id`,`fetched_at`);