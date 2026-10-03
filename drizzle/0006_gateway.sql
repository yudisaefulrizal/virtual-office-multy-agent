CREATE TABLE `approvals` (
	`id` varchar(36) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`status` varchar(32) NOT NULL,
	`objective_id` varchar(36),
	`task_id` varchar(36),
	`agent_id` varchar(36),
	`tool_id` varchar(64),
	`args` json NOT NULL DEFAULT (JSON_OBJECT()),
	`reason` text,
	`note` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`decided_at` datetime(3),
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tool_credentials` (
	`tool_id` varchar(64) NOT NULL,
	`secret_enc` text NOT NULL,
	`secret_last4` varchar(8) NOT NULL,
	`config` json NOT NULL DEFAULT (JSON_OBJECT()),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `tool_credentials_tool_id` PRIMARY KEY(`tool_id`)
);
--> statement-breakpoint
CREATE TABLE `tool_executions` (
	`id` varchar(36) NOT NULL,
	`tool_id` varchar(64) NOT NULL,
	`agent_id` varchar(36),
	`task_id` varchar(36),
	`session_id` varchar(36),
	`objective_id` varchar(36),
	`approval_id` varchar(36),
	`args` json NOT NULL DEFAULT (JSON_OBJECT()),
	`status` varchar(32) NOT NULL,
	`result` json,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`finished_at` datetime(3),
	CONSTRAINT `tool_executions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_task_idx` ON `tool_executions` (`task_id`);