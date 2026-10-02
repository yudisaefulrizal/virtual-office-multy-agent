import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { agentSessions, agents, artifacts, decisions, events, objectives, projects, roles, tasks } from '../db/schema';
import type { RuntimeId } from '../runtimes/runtime';
import type { OfficeContext } from './context';

export type AgentActivity = 'working' | 'waiting' | 'done' | 'idle' | 'inactive' | 'blocked';

export interface RuntimeInfo {
  id: RuntimeId;
  configured: boolean;
  concurrency: number;
  inflight: number;
  quota: { used: number; max: number; windowHours: number } | null;
  cooldownUntil: string | null;
  costKind: 'actual' | 'estimate' | null;
}

const RECENT_DONE_MS = 12 * 3600_000;

/** Status kantor untuk halaman Kantor 3D. */
export async function officeView(
  ctx: OfficeContext,
  runtimeState: (id: RuntimeId) => { inflight: number; cooldownUntil: Date | null },
) {
  const db = ctx.db;
  const agentRows = await db
    .select({ agent: agents, role: roles })
    .from(agents)
    .innerJoin(roles, eq(roles.id, agents.roleId))
    .orderBy(asc(agents.createdAt));

  const openTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['pending', 'queued', 'running']))
    .orderBy(asc(tasks.createdAt));
  const recentDone = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'completed'), gt(tasks.completedAt, new Date(Date.now() - RECENT_DONE_MS))))
    .orderBy(desc(tasks.completedAt));
  const runningSessions = await db.select().from(agentSessions).where(eq(agentSessions.status, 'running'));

  const agentsOut = agentRows.map(({ agent, role }) => {
    const running = openTasks.find((t) => t.assignedAgentId === agent.id && t.status === 'running');
    const waiting = openTasks.find((t) => t.assignedAgentId === agent.id && t.status !== 'running');
    const done = recentDone.find((t) => t.assignedAgentId === agent.id);
    const session = running && runningSessions.find((s) => s.taskId === running.id);

    let activity: AgentActivity = 'idle';
    let line = 'Siap menerima task';
    let task: { id: string; title: string; status: string; startedAt: string | null; attempt: number; maxAttempts: number; sessionId: string | null } | null = null;
    if (agent.status !== 'active') {
      activity = 'inactive';
      line = ctx.runtimes.has(agent.runtime as RuntimeId) ? 'Nonaktif' : `Menunggu provider ${agent.runtime}`;
    } else if (running) {
      activity = 'working';
      line = running.title;
    } else if (waiting) {
      activity = waiting.notBefore && waiting.notBefore > new Date() ? 'blocked' : 'waiting';
      line = activity === 'blocked' ? `Ditunda sampai ${waiting.notBefore!.toLocaleTimeString('id-ID')}` : `Antre: ${waiting.title}`;
    } else if (done) {
      activity = 'done';
      line = `Selesai: ${done.title}`;
    }
    const current = running ?? waiting;
    if (current) {
      task = {
        id: current.id,
        title: current.title,
        status: current.status,
        startedAt: current.startedAt?.toISOString() ?? null,
        attempt: current.attempt,
        maxAttempts: current.maxAttempts,
        sessionId: session?.id ?? null,
      };
    }
    return {
      id: agent.id,
      name: agent.name,
      roleId: role.id,
      roleName: role.name,
      department: role.department,
      runtime: agent.runtime,
      model: agent.model,
      status: agent.status,
      supervisorAgentId: agent.supervisorAgentId,
      workspacePath: agent.workspacePath,
      activity,
      line,
      task,
    };
  });

  const runtimeIds: RuntimeId[] = ['claude-cli', 'openrouter', 'fake'];
  const runtimesOut: RuntimeInfo[] = [];
  for (const id of runtimeIds) {
    const limits = ctx.limits.get(id);
    const configured = ctx.runtimes.has(id);
    if (!configured && !agentRows.some((r) => r.agent.runtime === id)) continue;
    let quota: RuntimeInfo['quota'] = null;
    if (limits?.maxRunsPerWindow && limits.windowHours) {
      const since = new Date(Date.now() - limits.windowHours * 3600_000);
      const [row] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(agentSessions)
        .where(and(eq(agentSessions.runtime, id), gt(agentSessions.startedAt, since)));
      quota = { used: row?.n ?? 0, max: limits.maxRunsPerWindow, windowHours: limits.windowHours };
    }
    const state = configured ? runtimeState(id) : { inflight: 0, cooldownUntil: null };
    runtimesOut.push({
      id,
      configured,
      concurrency: limits?.concurrency ?? 0,
      inflight: state.inflight,
      quota,
      cooldownUntil: state.cooldownUntil?.toISOString() ?? null,
      costKind: limits?.costKind ?? null,
    });
  }

  const failed = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'failed'), gt(tasks.completedAt, new Date(Date.now() - 24 * 3600_000))))
    .orderBy(desc(tasks.completedAt))
    .limit(5);
  const inbox = [
    ...failed.map((t) => ({ kind: 'task_failed' as const, taskId: t.id, objectiveId: t.objectiveId, title: t.title, detail: t.error ?? '' })),
    ...openTasks
      .filter((t) => t.status === 'pending' && !t.assignedAgentId)
      .map((t) => ({ kind: 'task_unassignable' as const, taskId: t.id, objectiveId: t.objectiveId, title: t.title, detail: `Butuh role ${t.requiredRoleId}` })),
  ];

  return {
    forceRuntime: ctx.forceRuntime ?? null,
    agents: agentsOut,
    runtimes: runtimesOut,
    inbox,
    events: await recentEvents(ctx, 30),
  };
}

export async function recentEvents(ctx: OfficeContext, limit: number, objectiveId?: string) {
  const rows = await ctx.db
    .select()
    .from(events)
    .where(objectiveId ? eq(events.objectiveId, objectiveId) : undefined)
    .orderBy(desc(events.id))
    .limit(limit);
  const names = new Map((await ctx.db.select({ id: agents.id, name: agents.name }).from(agents)).map((a) => [a.id, a.name]));
  return rows.map((e) => ({
    id: e.id,
    type: e.type,
    entityType: e.entityType,
    entityId: e.entityId,
    objectiveId: e.objectiveId,
    actor: e.actor,
    actorName: e.actor.startsWith('agent:') ? names.get(e.actor.slice(6)) ?? 'Agent' : labelActor(e.actor),
    payload: e.payload,
    createdAt: e.createdAt.toISOString(),
  }));
}

function labelActor(actor: string) {
  return ({ owner: 'Owner', orchestrator: 'Sistem', scheduler: 'Scheduler' } as Record<string, string>)[actor] ?? actor;
}

export async function listObjectives(ctx: OfficeContext) {
  const rows = await ctx.db
    .select({
      objective: objectives,
      total: sql<number>`(select count(*) from tasks t where t.objective_id = objectives.id)`.mapWith(Number),
      completed: sql<number>`(select count(*) from tasks t where t.objective_id = objectives.id and t.status = 'completed')`.mapWith(Number),
    })
    .from(objectives)
    .orderBy(desc(objectives.createdAt));
  return rows.map((r) => ({ ...r.objective, taskCount: r.total, completedCount: r.completed }));
}

/** Jejak lengkap: Objective → Decision → Project → Task → Session → Artifact. */
export async function objectiveTrace(ctx: OfficeContext, id: string) {
  const db = ctx.db;
  const [objective] = await db.select().from(objectives).where(eq(objectives.id, id));
  if (!objective) return null;
  const decisionRows = await db.select().from(decisions).where(eq(decisions.objectiveId, id)).orderBy(asc(decisions.createdAt));
  const projectRows = await db.select().from(projects).where(eq(projects.objectiveId, id)).orderBy(asc(projects.createdAt));
  const taskRows = await db
    .select({ task: tasks, agentName: agents.name })
    .from(tasks)
    .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
    .where(eq(tasks.objectiveId, id))
    .orderBy(asc(tasks.createdAt));
  const taskIds = taskRows.map((t) => t.task.id);
  const sessionRows = taskIds.length
    ? await db.select().from(agentSessions).where(inArray(agentSessions.taskId, taskIds)).orderBy(asc(agentSessions.startedAt))
    : [];
  const artifactRows = taskIds.length
    ? await db.select().from(artifacts).where(inArray(artifacts.taskId, taskIds)).orderBy(asc(artifacts.createdAt))
    : [];

  const usage = sessionRows.reduce(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
      costUsdMicros: acc.costUsdMicros + (s.costUsdMicros ?? 0),
    }),
    { sessions: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0 },
  );

  return {
    objective,
    decisions: decisionRows,
    projects: projectRows,
    tasks: taskRows.map(({ task, agentName }) => ({
      ...task,
      agentName,
      sessions: sessionRows.filter((s) => s.taskId === task.id),
      artifacts: artifactRows.filter((a) => a.taskId === task.id),
    })),
    usage,
    events: await recentEvents(ctx, 200, id),
  };
}
