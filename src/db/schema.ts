import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  uniqueIndex,
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
  /** Role yang boleh dipakai Manager dalam rencana kerja (task kind: work | research). */
  plannable: boolean('plannable').notNull().default(false),
  taskKind: varchar('task_kind', { length: 16 }),
  description: text('description'),
  createdBy: varchar('created_by', { length: 80 }).notNull().default('system'),
  createdAt: createdAt(),
});

/** Divisi = ruangan di kantor. Role menunjuk divisi lewat roles.department (= departments.id). */
export const departments = mysqlTable('departments', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  color: varchar('color', { length: 9 }).notNull(),
  sortOrder: int('sort_order').notNull().default(0),
  createdBy: varchar('created_by', { length: 80 }).notNull().default('system'),
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
  /** permanent: fungsi inti; on_demand: hidup hanya saat ada kerja; temporary: untuk satu objective. */
  tenure: varchar('tenure', { length: 16 }).notNull().default('permanent'),
  /** Untuk tenure temporary: objective yang dilayani. Selesai → dirumahkan, bisa dipakai ulang. */
  tempObjectiveId: id('temp_objective_id'),
  /** Kapan terakhir berubah status siklus hidup (dirumahkan/diaktifkan/dipensiunkan). */
  statusChangedAt: ts('status_changed_at'),
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
    /** Kapan task terakhir masuk antrean; dasar aturan HRD menambah staf. */
    queuedAt: ts('queued_at'),
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

/**
 * Knowledge organisasi (DESIGN.md §10). confidence & recheck_after dihitung
 * deterministik dari sumber dan kategori, bukan dari klaim model (A8).
 */
export const knowledge = mysqlTable(
  'knowledge',
  {
    id: id().primaryKey(),
    topic: varchar('topic', { length: 255 }).notNull(),
    topicKey: varchar('topic_key', { length: 255 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    content: text('content').notNull(),
    sources: json('sources').notNull().default(sql`(JSON_ARRAY())`),
    confidence: varchar('confidence', { length: 16 }).notNull(), // low | medium | high
    researchedAt: ts('researched_at').notNull(),
    lastVerifiedAt: ts('last_verified_at').notNull(),
    recheckAfter: ts('recheck_after').notNull(),
    createdByTaskId: id('created_by_task_id'),
    objectiveId: id('objective_id'),
    updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
  },
  (t) => [uniqueIndex('knowledge_topic_key_idx').on(t.topicKey), index('knowledge_category_idx').on(t.category)],
);

/** Persetujuan Owner untuk tindakan berisiko (DESIGN.md §21). Keputusan CEO memakai tabel decisions. */
export const approvals = mysqlTable(
  'approvals',
  {
    id: id().primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(), // tool
    status: status().notNull(), // pending | approved | rejected
    objectiveId: id('objective_id'),
    taskId: id('task_id'),
    agentId: id('agent_id'),
    toolId: varchar('tool_id', { length: 64 }),
    args: json('args').notNull().default(emptyJson),
    reason: text('reason'),
    note: text('note'),
    createdAt: createdAt(),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('approvals_status_idx').on(t.status, t.createdAt)],
);

/** Setiap pemanggilan tool lewat Gateway, termasuk yang ditolak (audit). */
export const toolExecutions = mysqlTable(
  'tool_executions',
  {
    id: id().primaryKey(),
    toolId: varchar('tool_id', { length: 64 }).notNull(),
    agentId: id('agent_id'),
    taskId: id('task_id'),
    sessionId: id('session_id'),
    objectiveId: id('objective_id'),
    approvalId: id('approval_id'),
    args: json('args').notNull().default(emptyJson),
    status: status().notNull(), // executed | failed | denied | pending_approval | rejected
    result: json('result'),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('tool_executions_task_idx').on(t.taskId)],
);

/** Credential tool eksternal (mis. Instagram), terenkripsi seperti provider. */
export const toolCredentials = mysqlTable('tool_credentials', {
  toolId: varchar('tool_id', { length: 64 }).primaryKey(),
  secretEnc: text('secret_enc').notNull(),
  secretLast4: varchar('secret_last4', { length: 8 }).notNull(),
  config: json('config').notNull().default(emptyJson),
  updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
});

/** Jadwal objective berulang (DESIGN.md §24): menjalankan ulang rencana, bukan strategi. */
export const schedules = mysqlTable('schedules', {
  id: id().primaryKey(),
  objectiveId: id('objective_id').notNull().unique().references(() => objectives.id),
  kind: varchar('kind', { length: 16 }).notNull(), // daily | interval
  timeOfDay: varchar('time_of_day', { length: 5 }), // HH:MM, untuk daily
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Jakarta'),
  intervalHours: int('interval_hours'),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: ts('next_run_at').notNull(),
  lastRunAt: ts('last_run_at'),
  createdAt: createdAt(),
});

/** Akun Instagram yang dihubungkan Owner lewat Instagram Login resmi. Token 60 hari, terenkripsi. */
export const instagramAccounts = mysqlTable('instagram_accounts', {
  igUserId: varchar('ig_user_id', { length: 32 }).primaryKey(),
  username: varchar('username', { length: 100 }).notNull(),
  accountType: varchar('account_type', { length: 30 }).notNull().default(''),
  tokenEnc: text('token_enc').notNull(),
  permissions: varchar('permissions', { length: 500 }).notNull().default(''),
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | revoked
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP(3))`),
});

/** State OAuth sekali pakai (hash), kedaluwarsa 10 menit. */
export const instagramStates = mysqlTable('instagram_states', {
  stateHash: varchar('state_hash', { length: 64 }).primaryKey(),
  createdAt: createdAt(),
});
