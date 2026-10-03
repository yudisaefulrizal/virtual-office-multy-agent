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
  kind: 'task_failed' | 'task_unassignable' | 'review_escalated';
  taskId: string;
  objectiveId: string;
  title: string;
  detail: string;
}

export interface OfficeView {
  forceRuntime: string | null;
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

export interface TraceTask {
  id: string;
  kind: string;
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

export interface ObjectiveTrace {
  objective: ObjectiveSummary & { updatedAt: string };
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

export interface AgentRow {
  id: string;
  name: string;
  roleId: string;
  roleName: string;
  department: string;
  runtime: string;
  model: string | null;
  status: string;
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
  objective: (id: string) => request<ObjectiveTrace>(`/api/objectives/${id}`),
  createObjective: (title: string, description: string, mode: 'planned' | 'direct') =>
    request<{ objectiveId: string }>('/api/objectives', { method: 'POST', body: JSON.stringify({ title, description, mode }) }),
  cancelTask: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  providers: () => request<ProviderInfo[]>('/api/providers'),
  setProvider: (id: string, body: { apiKey?: string; defaultModel: string }) =>
    request<ProviderInfo[]>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  agents: () => request<AgentRow[]>('/api/agents'),
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
