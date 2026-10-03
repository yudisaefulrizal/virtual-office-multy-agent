import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  serial,
  text,
  varchar,
  type AnyMySqlColumn,
} from 'drizzle-orm/mysql-core';

// Semua waktu disimpan sebagai UTC (koneksi memakai time_zone +00:00, lihat client.ts).
const ts = (name: string) => datetime(name, { mode: 'date', fsp: 3 });
const createdAt = () => ts('created_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`);
const id = (name = 'id') => varchar(name, { length: 36 });
const status = (name = 'status') => varchar(name, { length: 32 });
const emptyJson = sql`(JSON_OBJECT())`;

export const roles = mysqlTable('roles', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  department: varchar('department', { length: 64 }).notNull(),
  instructions: text('instructions').notNull(),
  nativeTools: varchar('native_tools', { length: 32 }).notNull(), // read_only | workspace_write | research
  createdAt: createdAt(),
});

export const agents = mysqlTable('agents', {
  id: id().primaryKey(),
  roleId: varchar('role_id', { length: 64 }).notNull().references(() => roles.id),
  name: varchar('name', { length: 128 }).notNull(),
  runtime: varchar('runtime', { length: 32 }).notNull(), // claude-cli | openrouter | fake
  model: varchar('model', { length: 64 }),
  status: status().notNull().default('active'),
  supervisorAgentId: id('supervisor_agent_id').references((): AnyMySqlColumn => agents.id),
  workspacePath: varchar('workspace_path', { length: 255 }).notNull(), // relatif terhadap WORKSPACES_DIR
  createdBy: varchar('created_by', { length: 80 }).notNull(),
  createdAt: createdAt(),
});

export const objectives = mysqlTable('objectives', {
  id: id().primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  constraints: json('constraints').notNull().default(emptyJson),
  status: status().notNull(),
  budgetUsdMicros: bigint('budget_usd_micros', { mode: 'number' }),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
});

export const decisions = mysqlTable('decisions', {
  id: id().primaryKey(),
  objectiveId: id('objective_id').notNull().references(() => objectives.id),
  /** Task CEO yang menghasilkan usulan ini (null untuk keputusan langsung Owner). */
  taskId: id('task_id'),
  content: json('content').notNull(),
  status: status().notNull(),
  proposedBy: varchar('proposed_by', { length: 80 }).notNull(),
  reviewedAt: ts('reviewed_at'),
  reviewNote: text('review_note'),
  createdAt: createdAt(),
});

export const projects = mysqlTable('projects', {
  id: id().primaryKey(),
  objectiveId: id('objective_id').notNull().references(() => objectives.id),
  decisionId: id('decision_id').references(() => decisions.id),
  title: varchar('title', { length: 255 }).notNull(),
  planTemplate: json('plan_template'),
  status: status().notNull(),
  createdAt: createdAt(),
});

export const tasks = mysqlTable(
  'tasks',
  {
    id: id().primaryKey(),
    objectiveId: id('objective_id').notNull().references(() => objectives.id),
    projectId: id('project_id').references(() => projects.id),
    kind: varchar('kind', { length: 32 }).notNull(),
    /** Key task di rencana Manager; revisi memakai key yang sama. */
    planKey: varchar('plan_key', { length: 64 }),
    title: varchar('title', { length: 255 }).notNull(),
    instructions: text('instructions').notNull(),
    input: json('input').notNull().default(emptyJson),
    requiredRoleId: varchar('required_role_id', { length: 64 }).references(() => roles.id),
    assignedAgentId: id('assigned_agent_id').references(() => agents.id),
    status: status().notNull(),
    attempt: int('attempt').notNull().default(0),
    maxAttempts: int('max_attempts').notNull().default(2),
    timeoutMs: int('timeout_ms').notNull().default(600_000),
    leaseUntil: ts('lease_until'),
    notBefore: ts('not_before'),
    result: json('result'),
    error: text('error'),
    retryOfTaskId: id('retry_of_task_id').references((): AnyMySqlColumn => tasks.id),
    requestedBy: varchar('requested_by', { length: 80 }).notNull(),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('tasks_status_idx').on(t.status, t.createdAt)],
);

export const taskDependencies = mysqlTable(
  'task_dependencies',
  {
    taskId: id('task_id').notNull().references(() => tasks.id),
    dependsOn: id('depends_on').notNull().references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOn] })],
);

export const agentSessions = mysqlTable(
  'agent_sessions',
  {
    id: id().primaryKey(),
    agentId: id('agent_id').notNull().references(() => agents.id),
    taskId: id('task_id').notNull().references(() => tasks.id),
    runtime: varchar('runtime', { length: 32 }).notNull(),
    model: varchar('model', { length: 64 }),
    externalSessionId: varchar('external_session_id', { length: 128 }),
    attempt: int('attempt').notNull(),
    purpose: varchar('purpose', { length: 16 }).notNull().default('run'), // run | repair
    status: status().notNull(), // running | ok | error | timeout | aborted | rate_limited | invalid_output
    inputTokens: int('input_tokens'),
    outputTokens: int('output_tokens'),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }),
    costKind: varchar('cost_kind', { length: 16 }), // actual | estimate
    error: text('error'),
    logPath: varchar('log_path', { length: 255 }),
    startedAt: ts('started_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
    endedAt: ts('ended_at'),
  },
  (t) => [index('agent_sessions_runtime_started_idx').on(t.runtime, t.startedAt)],
);

export const artifacts = mysqlTable('artifacts', {
  id: id().primaryKey(),
  taskId: id('task_id').notNull().references(() => tasks.id),
  sessionId: id('session_id').references(() => agentSessions.id),
  path: varchar('path', { length: 512 }).notNull(), // relatif terhadap WORKSPACES_DIR
  mimeType: varchar('mime_type', { length: 128 }),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

export const events = mysqlTable(
  'events',
  {
    id: serial('id').primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 32 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }).notNull(), // uuid entitas, atau id runtime
    objectiveId: id('objective_id'),
    actor: varchar('actor', { length: 80 }).notNull(),
    payload: json('payload').notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [index('events_objective_idx').on(t.objectiveId, t.id)],
);

/** Provider runtime berbasis API (mis. OpenRouter). API key terenkripsi (src/secrets.ts). */
export const providers = mysqlTable('providers', {
  id: varchar('id', { length: 32 }).primaryKey(), // openrouter
  apiKeyEnc: text('api_key_enc').notNull(),
  apiKeyLast4: varchar('api_key_last4', { length: 8 }).notNull(),
  defaultModel: varchar('default_model', { length: 128 }).notNull(),
  updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
});

/** Pengaturan Owner (mis. mode persetujuan keputusan). */
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: json('value').notNull(),
  updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
});
