import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { agentSessions, agents, approvals, departments, schedules, artifacts, decisions, events, objectives, projects, roles, taskDependencies, tasks, toolCredentials, toolExecutions } from '../db/schema';
import { ROLE_TOOLS, TOOLS, toolById } from '../gateway/tools';
import { spentUsdMicros } from './budget';
import { describeOrgChange } from './org';
import type { RuntimeId } from '../runtimes/runtime';
import type { OfficeContext } from './context';

export type AgentActivity = 'working' | 'waiting' | 'done' | 'idle' | 'inactive' | 'blocked';

export interface RuntimeInfo {
  id: RuntimeId;
  configured: boolean;
  concurrency: number;
  /** Batas dari konfigurasi; concurrency bisa turun sementara setelah rate limit. */
  maxConcurrency: number;
  inflight: number;
  quota: { used: number; max: number; windowHours: number } | null;
  cooldownUntil: string | null;
  costKind: 'actual' | 'estimate' | null;
}

const RECENT_DONE_MS = 12 * 3600_000;

/** Status kantor untuk halaman Kantor 3D. */
export async function officeView(
  ctx: OfficeContext,
  runtimeState: (id: RuntimeId) => { inflight: number; cooldownUntil: Date | null; concurrency?: number },
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
      createdAt: agent.createdAt,
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

  // Kepala divisi = karyawan aktif tertua di divisinya.
  const headOf = new Map<string, string>();
  for (const a of [...agentsOut].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
    if (a.status !== 'inactive' && !headOf.has(a.department)) headOf.set(a.department, a.id);
  }
  const agentsView = agentsOut.map(({ createdAt: _c, ...a }) => ({ ...a, isHead: headOf.get(a.department) === a.id }));
  const departmentRows = await db.select().from(departments).orderBy(asc(departments.sortOrder), asc(departments.id));

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
      concurrency: state.concurrency ?? limits?.concurrency ?? 0,
      maxConcurrency: limits?.concurrency ?? 0,
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
  const escalated = await db
    .select()
    .from(events)
    .where(and(eq(events.type, 'review.escalated'), gt(events.createdAt, new Date(Date.now() - 24 * 3600_000))))
    .orderBy(desc(events.id))
    .limit(5);
  const objectiveTitles = new Map(
    escalated.length
      ? (await db.select({ id: objectives.id, title: objectives.title }).from(objectives).where(inArray(objectives.id, escalated.map((e) => e.objectiveId!)))).map((o) => [o.id, o.title])
      : [],
  );
  const pendingDecisions = await db
    .select({ id: decisions.id, objectiveId: decisions.objectiveId, title: objectives.title, content: decisions.content })
    .from(decisions)
    .innerJoin(objectives, eq(objectives.id, decisions.objectiveId))
    .where(eq(decisions.status, 'proposed'))
    .orderBy(desc(decisions.createdAt));
  const pendingApprovals = await db
    .select({ approval: approvals, agentName: agents.name })
    .from(approvals)
    .leftJoin(agents, eq(agents.id, approvals.agentId))
    .where(eq(approvals.status, 'pending'))
    .orderBy(desc(approvals.createdAt));
  const budgetBlocked = await db
    .selectDistinct({ objectiveId: tasks.objectiveId, title: objectives.title })
    .from(tasks)
    .innerJoin(objectives, eq(objectives.id, tasks.objectiveId))
    .where(and(eq(tasks.status, 'queued'), eq(tasks.error, 'Budget objective habis')));
  const notices = await db
    .select()
    .from(events)
    .where(and(eq(events.type, 'owner.notified'), gt(events.createdAt, new Date(Date.now() - 24 * 3600_000))))
    .orderBy(desc(events.id))
    .limit(5);
  const nameOf = new Map(agentRows.map((r) => [r.agent.id, r.agent.name]));
  const inbox = [
    ...pendingApprovals.map(({ approval: a, agentName }) => ({
      kind: 'approval_pending' as const,
      taskId: a.id,
      objectiveId: a.objectiveId ?? '',
      title: `${toolById(a.toolId ?? '')?.title ?? a.toolId} — diminta ${agentName ?? 'sistem'}`,
      detail: (a.toolId === 'propose_org_change' ? describeOrgChange(a.args as never) : JSON.stringify(a.args)).slice(0, 400),
    })),
    ...budgetBlocked.map((b) => ({
      kind: 'budget_exceeded' as const,
      taskId: b.objectiveId,
      objectiveId: b.objectiveId,
      title: b.title,
      detail: 'Budget API objective habis. Naikkan budget di halaman objective agar task berjalan lagi.',
    })),
    ...notices.map((n) => ({
      kind: 'owner_notice' as const,
      taskId: String(n.id),
      objectiveId: n.objectiveId ?? '',
      title: `${nameOf.get(n.actor.slice(6)) ?? 'Agent'}: ${(n.payload as { title?: string }).title ?? ''}`,
      detail: String((n.payload as { message?: string }).message ?? '').slice(0, 300),
    })),
    ...pendingDecisions.map((d) => ({
      kind: 'decision_pending' as const,
      taskId: d.id,
      objectiveId: d.objectiveId,
      title: d.title,
      detail: `CEO mengusulkan: ${(d.content as { strategy?: string }).strategy ?? ''}`.slice(0, 240),
    })),
    ...escalated.map((e) => ({
      kind: 'review_escalated' as const,
      taskId: e.entityId,
      objectiveId: e.objectiveId!,
      title: objectiveTitles.get(e.objectiveId!) ?? 'Objective',
      detail: `Manager belum puas setelah ${(e.payload as { round?: number }).round ?? 3} putaran review. Keputusan akhir di tangan Anda.`,
    })),
    ...failed.map((t) => ({ kind: 'task_failed' as const, taskId: t.id, objectiveId: t.objectiveId, title: t.title, detail: t.error ?? '' })),
    ...openTasks
      // Hanya task yang memang tidak menemukan agent (error di-set oleh promoteReadyTasks),
      // bukan task yang sekadar menunggu dependency.
      .filter((t) => t.status === 'pending' && !t.assignedAgentId && t.error)
      .map((t) => ({ kind: 'task_unassignable' as const, taskId: t.id, objectiveId: t.objectiveId, title: t.title, detail: t.error ?? `Butuh role ${t.requiredRoleId}` })),
  ];

  // Rapat strategi: ada task framing/konsultasi/keputusan yang sedang berjalan.
  const strategic = openTasks.find((t) => ['framing', 'consultation', 'decision'].includes(t.kind) && t.status === 'running')
    ?? openTasks.find((t) => ['framing', 'consultation', 'decision'].includes(t.kind));
  const meeting = strategic
    ? {
        objectiveId: strategic.objectiveId,
        title: (await db.select({ title: objectives.title }).from(objectives).where(eq(objectives.id, strategic.objectiveId)))[0]?.title ?? '',
        participants: [...new Set(openTasks.filter((t) => t.objectiveId === strategic.objectiveId && !t.projectId).map((t) => t.assignedAgentId).filter(Boolean))] as string[],
      }
    : null;

  const [next] = await db
    .select({ objectiveId: schedules.objectiveId, at: schedules.nextRunAt, title: objectives.title })
    .from(schedules)
    .innerJoin(objectives, eq(objectives.id, schedules.objectiveId))
    .where(and(eq(schedules.enabled, true), eq(objectives.status, 'active')))
    .orderBy(asc(schedules.nextRunAt))
    .limit(1);

  return {
    forceRuntime: ctx.forceRuntime ?? null,
    meeting,
    departments: departmentRows.map((d) => ({ id: d.id, name: d.name, color: d.color })),
    nextRun: next ? { objectiveId: next.objectiveId, title: next.title, at: next.at.toISOString() } : null,
    agents: agentsView,
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
  const depRows = taskIds.length
    ? await db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, taskIds))
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

  const toolRows = taskIds.length
    ? await db.select().from(toolExecutions).where(inArray(toolExecutions.taskId, taskIds)).orderBy(asc(toolExecutions.createdAt))
    : [];

  const [schedule] = await db.select().from(schedules).where(eq(schedules.objectiveId, id));

  return {
    objective,
    schedule: schedule ?? null,
    budget: { budgetUsdMicros: objective.budgetUsdMicros, spentUsdMicros: await spentUsdMicros(db, id) },
    toolExecutions: toolRows,
    decisions: decisionRows,
    projects: projectRows,
    tasks: taskRows.map(({ task, agentName }) => ({
      ...task,
      agentName,
      dependsOn: depRows.filter((d) => d.taskId === task.id).map((d) => d.dependsOn),
      sessions: sessionRows.filter((s) => s.taskId === task.id),
      artifacts: artifactRows.filter((a) => a.taskId === task.id),
    })),
    usage,
    events: await recentEvents(ctx, 200, id),
  };
}

export async function listDecisions(ctx: OfficeContext) {
  const rows = await ctx.db
    .select({ decision: decisions, objectiveTitle: objectives.title, objectiveStatus: objectives.status })
    .from(decisions)
    .innerJoin(objectives, eq(objectives.id, decisions.objectiveId))
    .orderBy(desc(decisions.createdAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.decision.id,
    objectiveId: r.decision.objectiveId,
    objectiveTitle: r.objectiveTitle,
    objectiveStatus: r.objectiveStatus,
    status: r.decision.status,
    proposedBy: r.decision.proposedBy,
    strategy: (r.decision.content as { strategy?: string }).strategy ?? '',
    createdAt: r.decision.createdAt.toISOString(),
  }));
}

/** Usulan keputusan beserta bahan pertimbangannya: kerangka CEO dan hasil konsultasi. */
export async function decisionDetail(ctx: OfficeContext, id: string) {
  const db = ctx.db;
  const [d] = await db.select().from(decisions).where(eq(decisions.id, id));
  if (!d) return null;
  const [objective] = await db.select().from(objectives).where(eq(objectives.id, d.objectiveId));
  const inputs = d.taskId
    ? await db
        .select({ task: tasks, agentName: agents.name })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
        .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
        .where(eq(taskDependencies.taskId, d.taskId))
    : [];
  const history = await db.select().from(decisions).where(eq(decisions.objectiveId, d.objectiveId)).orderBy(asc(decisions.createdAt));
  const ceo = d.proposedBy.startsWith('agent:')
    ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, d.proposedBy.slice(6))))[0]?.name
    : 'Owner';
  return {
    decision: { ...d, proposedByName: ceo ?? 'Agent' },
    objective,
    inputs: inputs.map((i) => ({ id: i.task.id, kind: i.task.kind, title: i.task.title, agentName: i.agentName, status: i.task.status, result: i.task.result })),
    history: history.map((h) => ({ id: h.id, status: h.status, createdAt: h.createdAt.toISOString(), reviewNote: h.reviewNote })),
    providers: [...ctx.runtimes.keys()],
  };
}

export async function listApprovals(ctx: OfficeContext, status?: string) {
  const rows = await ctx.db
    .select({ approval: approvals, agentName: agents.name, objectiveTitle: objectives.title })
    .from(approvals)
    .leftJoin(agents, eq(agents.id, approvals.agentId))
    .leftJoin(objectives, eq(objectives.id, approvals.objectiveId))
    .where(status ? eq(approvals.status, status) : undefined)
    .orderBy(desc(approvals.createdAt))
    .limit(100);
  return rows.map((r) => ({
    ...r.approval,
    agentName: r.agentName,
    objectiveTitle: r.objectiveTitle,
    toolTitle: toolById(r.approval.toolId ?? '')?.title ?? r.approval.toolId,
  }));
}

/** Katalog tool: risiko, role yang diizinkan, dan status credential (tanpa membocorkan isinya). */
export async function listTools(ctx: OfficeContext) {
  const creds = await ctx.db.select({ toolId: toolCredentials.toolId, last4: toolCredentials.secretLast4, config: toolCredentials.config }).from(toolCredentials);
  return TOOLS.map((t) => {
    const c = creds.find((x) => x.toolId === t.id);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      risk: t.risk,
      roles: Object.entries(ROLE_TOOLS).filter(([, ids]) => ids.includes(t.id)).map(([r]) => r),
      credential: t.credential
        ? { label: t.credential.label, configFields: t.credential.configFields, configured: !!c, last4: c?.last4 ?? null, config: (c?.config as Record<string, string>) ?? {} }
        : null,
    };
  });
}
