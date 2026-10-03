import { useCallback, useEffect, useRef, useState } from 'react';

export type Activity = 'working' | 'waiting' | 'done' | 'idle' | 'inactive' | 'blocked';

export interface OfficeAgent {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  department: string;
  runtime: string;
  model: string | null;
  status: string;
  supervisorAgentId: string | null;
  workspacePath: string;
  isHead: boolean;
  activity: Activity;
  line: string;
  task: {
    id: string;
    title: string;
    status: string;
    startedAt: string | null;
    attempt: number;
    maxAttempts: number;
    sessionId: string | null;
  } | null;
}

export interface RuntimeInfo {
  id: string;
  configured: boolean;
  concurrency: number;
  maxConcurrency: number;
  inflight: number;
  quota: { used: number; max: number; windowHours: number } | null;
  cooldownUntil: string | null;
  costKind: 'actual' | 'estimate' | null;
}

export interface OfficeEvent {
  id: number;
  type: string;
  entityType: string;
  entityId: string;
  objectiveId: string | null;
  actor: string;
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface InboxItem {
  kind: 'task_failed' | 'task_unassignable' | 'review_escalated' | 'decision_pending' | 'approval_pending' | 'budget_exceeded' | 'owner_notice';
  taskId: string;
  objectiveId: string;
  title: string;
  detail: string;
}

export interface ScheduleInput {
  kind: 'daily' | 'interval';
  timeOfDay?: string;
  intervalHours?: number;
  timezone?: string;
  enabled?: boolean;
}

export interface Schedule extends ScheduleInput {
  id: string;
  nextRunAt: string;
  lastRunAt: string | null;
}

export interface Department {
  id: string;
  name: string;
  color: string;
}

export interface OfficeView {
  forceRuntime: string | null;
  departments: Department[];
  nextRun: { objectiveId: string; title: string; at: string } | null;
  meeting: { objectiveId: string; title: string; participants: string[] } | null;
  agents: OfficeAgent[];
  runtimes: RuntimeInfo[];
  inbox: InboxItem[];
  events: OfficeEvent[];
}

export interface ObjectiveSummary {
  id: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  taskCount: number;
  completedCount: number;
}

export interface Session {
  id: string;
  runtime: string;
  model: string | null;
  attempt: number;
  purpose: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
  costKind: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Artifact {
  id: string;
  path: string;
  mimeType: string | null;
  bytes: number;
  createdAt: string;
}

export interface ResultFile {
  id: string;
  name: string;
  mimeType: string | null;
  bytes: number;
  createdAt: string;
}

export interface ResultOutput {
  taskId: string;
  title: string;
  kind: string;
  agentName: string | null;
  summary: string | null;
  completedAt: string | null;
  final: boolean;
  files: ResultFile[];
}

export interface ObjectiveResult {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  fileCount: number;
  totalBytes: number;
  finalCount: number;
  outputs: ResultOutput[];
}

export interface TraceTask {
  id: string;
  kind: string;
  projectId: string | null;
  planKey: string | null;
  dependsOn: string[];
  retryOfTaskId: string | null;
  assignedAgentId: string | null;
  title: string;
  instructions: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  agentName: string | null;
  error: string | null;
  result: {
    summary?: string;
    assumptions?: string[];
    findings?: { point: string; source: string }[];
    verdict?: 'accept' | 'revise';
    feedback?: string;
    revisions?: { task_key: string; instructions: string }[];
    tasks?: { key: string; title: string; role: string }[];
  } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  sessions: Session[];
  artifacts: Artifact[];
}

export interface ToolExecution {
  id: string;
  toolId: string;
  agentId: string | null;
  taskId: string | null;
  status: string;
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  createdAt: string;
}

export interface ToolInfo {
  id: string;
  title: string;
  description: string;
  risk: 'low' | 'high';
  roles: string[];
  credential: { label: string; configFields: { key: string; label: string }[]; configured: boolean; last4: string | null; config: Record<string, string> } | null;
}

export interface ObjectiveTrace {
  objective: ObjectiveSummary & { updatedAt: string; budgetUsdMicros: number | null };
  budget: { budgetUsdMicros: number | null; spentUsdMicros: number };
  schedule: Schedule | null;
  toolExecutions: ToolExecution[];
  decisions: { id: string; status: string; proposedBy: string; content: { strategy?: string }; createdAt: string }[];
  projects: { id: string; title: string; status: string; planTemplate: { summary: string; review_focus: string } | null }[];
  tasks: TraceTask[];
  usage: { sessions: number; inputTokens: number; outputTokens: number; costUsdMicros: number };
  events: OfficeEvent[];
}

export interface ProviderInfo {
  id: string;
  configured: boolean;
  apiKeyLast4: string | null;
  defaultModel: string | null;
  updatedAt: string | null;
}

export interface InstagramOverview {
  app: { configured: boolean; appId: string; secretLast4: string | null; redirectUri: string };
  accounts: { id: string; username: string; accountType: string; status: 'active' | 'expiring' | 'expired' | 'revoked'; daysLeft: number; canPublish: boolean }[];
}

export interface AgentRow {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  department: string;
  runtime: string;
  model: string | null;
  status: string;
  tenure: string;
}

export interface AgentPerformance {
  agentId: string;
  name: string;
  roleId: string;
  roleName: string;
  status: string;
  tenure: string;
  runtime: string;
  model: string | null;
  tasksDone: number;
  tasksFailed: number;
  revised: number;
  retried: number;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  costKind: string | null;
  utilization: number;
  lastActiveAt: string | null;
}

export interface Performance {
  agents: AgentPerformance[];
  recommendations: { agentId: string | null; roleId: string | null; level: 'info' | 'warn'; text: string }[];
}

export type ObjectiveMode = 'strategic' | 'planned' | 'direct';

export interface UsageBucket {
  sessions: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  actualUsdMicros: number;
  estimateUsdMicros: number;
  durationMs: number;
}

export interface UsageStats {
  days: number;
  usdToIdr: number;
  today: UsageBucket & { tasks: { completed: number; failed: number } };
  month: UsageBucket;
  byDay: (UsageBucket & { date: string })[];
  byAgent: (UsageBucket & { id: string; name: string })[];
  byObjective: (UsageBucket & { id: string; title: string })[];
  byRuntime: (UsageBucket & { runtime: string; model: string | null })[];
  tools: { toolId: string; statuses: Record<string, number> }[];
}

export interface KnowledgeItem {
  id: string;
  topic: string;
  category: string;
  content: string;
  sources: string[];
  confidence: 'low' | 'medium' | 'high';
  researchedAt: string;
  lastVerifiedAt: string;
  recheckAfter: string;
  objectiveId: string | null;
  stale: boolean;
}

export interface CompanyCharter {
  name: string;
  businessType: string;
  product: string;
  audience: string;
  guidelines: string;
  forbidden: string;
  monthlyBudgetUsd: number;
  maxActiveObjectives: number;
  maxNewPerCycle: number;
  cycleHours: number;
  autoPublish: boolean;
}

export interface CompanyStatus {
  company: (CompanyCharter & { running: boolean; pausedReason: string | null; lastAgendaAt: string | null }) | null;
  state: 'unset' | 'running' | 'paused';
  waiting: string | null;
  nextAgendaAt: string | null;
  spentUsd: number;
  quota: { used: number; max: number } | null;
  objectives: { id: string; title: string; status: string; mode: string; createdAt: string }[];
}

export interface Settings {
  decision_approval: 'always' | 'auto';
  usd_to_idr: number;
  max_staff_per_role: number;
  auto_hire: 'auto' | 'ask';
  hire_wait_seconds: number;
  suspend_idle_minutes: number;
  claude_max_runs_per_window: number;
  quota_counted_since: string;
}

export interface OrgRole {
  id: string;
  name: string;
  nativeTools: string;
  plannable: boolean;
  taskKind: string | null;
  createdBy: string;
  staff: number;
}

export interface OrgDepartment extends Department {
  createdBy: string;
  staff: number;
  roles: OrgRole[];
}

export interface Org {
  limits: { maxStaffPerRole: number; autoHire: 'auto' | 'ask'; hireWaitSeconds: number };
  departments: OrgDepartment[];
}

export interface OrgChange {
  type: 'hire' | 'new_department' | 'new_role';
  reason?: string;
  role_id?: string;
  runtime?: 'claude-cli' | 'openrouter';
  name?: string;
  department_id?: string;
  instructions?: string;
  native_tools?: 'read_only' | 'workspace_write' | 'research';
  task_kind?: 'work' | 'research';
  description?: string;
}

export interface DecisionSummary {
  id: string;
  objectiveId: string;
  objectiveTitle: string;
  objectiveStatus: string;
  status: string;
  proposedBy: string;
  strategy: string;
  createdAt: string;
}

export interface DecisionProposal {
  strategy: string;
  success_metrics: string[];
  budget_cap_usd: number;
  team: { role: string; runtime: string; reason: string }[];
  owner_requests: { type: string; key: string; reason: string; amount_usd?: number }[];
  execution_brief: string;
}

export interface DecisionDetail {
  decision: {
    id: string;
    objectiveId: string;
    status: string;
    content: DecisionProposal;
    proposedByName: string;
    reviewNote: string | null;
    createdAt: string;
  };
  objective: { id: string; title: string; description: string; status: string };
  inputs: { id: string; kind: string; title: string; agentName: string | null; status: string; result: Record<string, any> | null }[];
  history: { id: string; status: string; createdAt: string; reviewNote: string | null }[];
  providers: string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  office: () => request<OfficeView>('/api/office'),
  objectives: () => request<ObjectiveSummary[]>('/api/objectives'),
  results: () => request<ObjectiveResult[]>('/api/results'),
  objective: (id: string) => request<ObjectiveTrace>(`/api/objectives/${id}`),
  setSchedule: (id: string, schedule: ScheduleInput | null) =>
    request<{ ok: boolean }>(`/api/objectives/${id}/schedule`, schedule ? { method: 'PUT', body: JSON.stringify(schedule) } : { method: 'DELETE' }),
  cancelTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  providers: () => request<ProviderInfo[]>('/api/providers'),
  decisions: () => request<DecisionSummary[]>('/api/decisions'),
  decision: (id: string) => request<DecisionDetail>(`/api/decisions/${id}`),
  decide: (id: string, action: 'approve' | 'revise' | 'reject', note?: string) =>
    request<{ ok: boolean }>(`/api/decisions/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) }),
  knowledge: (q: string, category: string) =>
    request<KnowledgeItem[]>(`/api/knowledge?${new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}) })}`),
  deleteKnowledge: (id: string) => request<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
  stats: (days: number) => request<UsageStats>(`/api/stats?days=${days}`),
  org: () => request<Org>('/api/org'),
  applyOrg: (body: OrgChange) => request<Org>('/api/org', { method: 'POST', body: JSON.stringify(body) }),
  settings: () => request<Settings>('/api/settings'),
  decideApproval: (id: string, action: 'approve' | 'reject', note?: string) =>
    request<{ ok: boolean; message?: string }>(`/api/approvals/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) }),
  tools: () => request<ToolInfo[]>('/api/tools'),
  setToolCredential: (id: string, body: { secret?: string; config: Record<string, string> }) =>
    request<ToolInfo[]>(`/api/tools/${id}/credential`, { method: 'PUT', body: JSON.stringify(body) }),
  setBudget: (id: string, budgetUsd: number | null) =>
    request<{ ok: boolean }>(`/api/objectives/${id}`, { method: 'PATCH', body: JSON.stringify({ budgetUsd }) }),
  company: () => request<CompanyStatus>('/api/company'),
  saveCompany: (body: CompanyCharter) => request<CompanyStatus>('/api/company', { method: 'PUT', body: JSON.stringify(body) }),
  companyAction: (action: 'start' | 'pause') => request<CompanyStatus>(`/api/company/${action}`, { method: 'POST' }),
  resetQuota: () => request<{ ok: boolean }>('/api/quota/reset', { method: 'POST' }),
  deleteObjective: async (id: string) => {
    const res = await fetch(`/api/objectives/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  },
  updateSettings: (body: Partial<Settings>) => request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  instagram: () => request<InstagramOverview>('/api/instagram'),
  saveInstagramApp: (body: { appId: string; appSecret?: string }) => request<InstagramOverview>('/api/instagram/app', { method: 'PUT', body: JSON.stringify(body) }),
  removeInstagramApp: () => request<InstagramOverview>('/api/instagram/app', { method: 'DELETE' }),
  connectInstagram: () => request<{ url: string }>('/api/instagram/connect', { method: 'POST' }),
  refreshInstagram: (id: string) => request<InstagramOverview>(`/api/instagram/accounts/${id}/refresh`, { method: 'POST' }),
  disconnectInstagram: (id: string) => request<InstagramOverview>(`/api/instagram/accounts/${id}`, { method: 'DELETE' }),
  removeProvider: (id: string) => request<ProviderInfo[]>(`/api/providers/${id}`, { method: 'DELETE' }),
  removeToolCredential: (id: string) => request<ToolInfo[]>(`/api/tools/${id}/credential`, { method: 'DELETE' }),
  setProvider: (id: string, body: { apiKey?: string; defaultModel: string }) =>
    request<ProviderInfo[]>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  agents: () => request<AgentRow[]>('/api/agents'),
  performance: () => request<Performance>('/api/performance'),
  agentLifecycle: (id: string, action: 'suspend' | 'reactivate' | 'retire') =>
    request<{ ok?: boolean }>(`/api/agents/${id}/lifecycle`, { method: 'POST', body: JSON.stringify({ action }) }),
  updateAgent: (id: string, body: { runtime?: string; model?: string | null; status?: string }) =>
    request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

/** Satu koneksi SSE untuk seluruh aplikasi; komponen berlangganan lewat useLive. */
const listeners = new Set<() => void>();
let source: EventSource | null = null;
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/stream');
    source.onmessage = () => listeners.forEach((l) => l());
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Ambil data, lalu muat ulang setiap ada event dari server (dengan debounce). */
export function useLive<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(() => {
    loadRef
      .current()
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribe(() => {
      clearTimeout(t);
      t = setTimeout(refresh, 250);
    });
    const poll = setInterval(refresh, 15_000);
    return () => (unsub(), clearInterval(poll), clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
