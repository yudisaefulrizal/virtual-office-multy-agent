CREATE TABLE `instagram_accounts` (
	`ig_user_id` varchar(32) NOT NULL,
	`username` varchar(100) NOT NULL,
	`account_type` varchar(30) NOT NULL DEFAULT '',
	`token_enc` text NOT NULL,
	`permissions` varchar(500) NOT NULL DEFAULT '',
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `instagram_accounts_ig_user_id` PRIMARY KEY(`ig_user_id`)
);
--> statement-breakpoint
CREATE TABLE `instagram_states` (
	`state_hash` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `instagram_states_state_hash` PRIMARY KEY(`state_hash`)
);
