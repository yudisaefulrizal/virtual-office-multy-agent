CREATE TABLE `agent_sessions` (
	`id` varchar(36) NOT NULL,
	`agent_id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`runtime` varchar(32) NOT NULL,
	`model` varchar(64),
	`external_session_id` varchar(128),
	`attempt` int NOT NULL,
	`purpose` varchar(16) NOT NULL DEFAULT 'run',
	`status` varchar(32) NOT NULL,
	`input_tokens` int,
	`output_tokens` int,
	`cost_usd_micros` bigint,
	`cost_kind` varchar(16),
	`error` text,
	`log_path` varchar(255),
	`started_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`ended_at` datetime(3),
	CONSTRAINT `agent_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` varchar(36) NOT NULL,
	`role_id` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`runtime` varchar(32) NOT NULL,
	`model` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`supervisor_agent_id` varchar(36),
	`workspace_path` varchar(255) NOT NULL,
	`created_by` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`session_id` varchar(36),
	`path` varchar(512) NOT NULL,
	`mime_type` varchar(128),
	`sha256` varchar(64) NOT NULL,
	`bytes` bigint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` varchar(36) NOT NULL,
	`objective_id` varchar(36) NOT NULL,
	`content` json NOT NULL,
	`status` varchar(32) NOT NULL,
	`proposed_by` varchar(80) NOT NULL,
	`reviewed_at` datetime(3),
	`review_note` text,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` serial AUTO_INCREMENT NOT NULL,
	`type` varchar(64) NOT NULL,
	`entity_type` varchar(32) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`objective_id` varchar(36),
	`actor` varchar(80) NOT NULL,
	`payload` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` varchar(36) NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`constraints` json NOT NULL DEFAULT (JSON_OBJECT()),
	`status` varchar(32) NOT NULL,
	`budget_usd_micros` bigint,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `objectives_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`objective_id` varchar(36) NOT NULL,
	`decision_id` varchar(36),
	`title` varchar(255) NOT NULL,
	`plan_template` json,
	`status` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`department` varchar(64) NOT NULL,
	`instructions` text NOT NULL,
	`native_tools` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `roles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` varchar(36) NOT NULL,
	`depends_on` varchar(36) NOT NULL,
	CONSTRAINT `task_dependencies_task_id_depends_on_pk` PRIMARY KEY(`task_id`,`depends_on`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(36) NOT NULL,
	`objective_id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`kind` varchar(32) NOT NULL,
	`title` varchar(255) NOT NULL,
	`instructions` text NOT NULL,
	`input` json NOT NULL DEFAULT (JSON_OBJECT()),
	`required_role_id` varchar(64),
	`assigned_agent_id` varchar(36),
	`status` varchar(32) NOT NULL,
	`attempt` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 2,
	`timeout_ms` int NOT NULL DEFAULT 600000,
	`lease_until` datetime(3),
	`not_before` datetime(3),
	`result` json,
	`error` text,
	`retry_of_task_id` varchar(36),
	`requested_by` varchar(80) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD CONSTRAINT `agent_sessions_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD CONSTRAINT `agent_sessions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agents` ADD CONSTRAINT `agents_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agents` ADD CONSTRAINT `agents_supervisor_agent_id_agents_id_fk` FOREIGN KEY (`supervisor_agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifacts` ADD CONSTRAINT `artifacts_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifacts` ADD CONSTRAINT `artifacts_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `decisions` ADD CONSTRAINT `decisions_objective_id_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_objective_id_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_decision_id_decisions_id_fk` FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD CONSTRAINT `task_dependencies_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_dependencies` ADD CONSTRAINT `task_dependencies_depends_on_tasks_id_fk` FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_objective_id_objectives_id_fk` FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_required_role_id_roles_id_fk` FOREIGN KEY (`required_role_id`) REFERENCES `roles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assigned_agent_id_agents_id_fk` FOREIGN KEY (`assigned_agent_id`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_retry_of_task_id_tasks_id_fk` FOREIGN KEY (`retry_of_task_id`) REFERENCES `tasks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_sessions_runtime_started_idx` ON `agent_sessions` (`runtime`,`started_at`);--> statement-breakpoint
CREATE INDEX `events_objective_idx` ON `events` (`objective_id`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`,`created_at`);