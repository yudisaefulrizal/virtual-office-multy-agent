import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DEPARTMENTS,
  INITIAL_AGENTS,
  MAX_REVISION_ROUNDS,
  ROLES,
  planningInstructions,
  reviewInstructions,
  revisionInstructions,
} from '../agents/roles';
import { kindSpec, topoOrder, type DecisionProposal, type Framing, type Plan, type Review } from '../agents/schemas';
import type { Tx } from '../db/client';
import { agents, decisions, departments, objectives, projects, roles, schedules, taskDependencies, tasks } from '../db/schema';
import { Objective, Project, type Actor, type ObjectiveStatus, type ProjectStatus, type TaskKind, type TaskStatus } from '../domain';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';
import { type KnowledgeInput, upsertKnowledge } from './knowledge';
import { loadPlannableRoles } from './org';
import { onDecisionCompleted, onFramingCompleted, onStrategicTaskFinished, startStrategicLoop } from './strategy';

type TaskRow = typeof tasks.$inferSelect;

/** Isi role dan karyawan awal. Idempotent. */
export async function seedOrganization(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    // Divisi bawaan hanya dibuat jika belum ada; perubahan Owner tidak ditimpa.
    for (const [i, d] of DEPARTMENTS.entries()) {
      await tx.insert(departments).values({ ...d, sortOrder: i }).onDuplicateKeyUpdate({ set: { id: d.id } });
    }
    for (const { plannable, ...r } of ROLES) {
      const row = { ...r, plannable: !!plannable, taskKind: plannable?.kind ?? null, description: plannable?.description ?? null };
      await tx
        .insert(roles)
        .values(row)
        .onDuplicateKeyUpdate({
          set: { name: r.name, department: r.department, instructions: r.instructions, nativeTools: r.nativeTools, plannable: row.plannable, taskKind: row.taskKind, description: row.description },
        });
    }
    const existing = await tx.select({ id: agents.id }).from(agents).limit(1);
    if (existing.length > 0) return;

    const byName = new Map<string, string>();
    for (const a of INITIAL_AGENTS) {
      const id = randomUUID();
      byName.set(a.name, id);
      await tx.insert(agents).values({
        id,
        roleId: a.roleId,
        name: a.name,
        runtime: a.runtime,
        model: a.runtime === 'claude-cli' ? ctx.defaultModel : null,
        status: a.status ?? 'active',
        supervisorAgentId: a.supervisor ? byName.get(a.supervisor) ?? null : null,
        workspacePath: `agents/${id}`,
        createdBy: 'owner',
      });
      emit({ type: 'agent.created', entityType: 'agent', entityId: id, actor: 'owner', payload: { name: a.name, roleId: a.roleId } });
    }
  });
}

/**
 * Pilih agent aktif dengan role yang diminta dan runtime yang mampu
 * mengerjakan task kind tersebut (DESIGN.md §6.4). Beban paling ringan menang.
 */
export async function pickAgent(ctx: OfficeContext, tx: Tx, roleId: string, kind: string) {
  const requires = kindSpec(kind).requires;
  const candidates = await tx
    .select({
      id: agents.id,
      runtime: agents.runtime,
      load: sql<number>`(select count(*) from tasks t where t.assigned_agent_id = agents.id and t.status in ('queued','running'))`.mapWith(Number),
    })
    .from(agents)
    .where(and(eq(agents.roleId, roleId), eq(agents.status, 'active')));
  const capable = candidates.filter((c) => {
    const rt = ctx.runtimes.get(effectiveRuntime(ctx, c.runtime));
    return rt && requires.every((cap) => rt.capabilities.has(cap));
  });
  capable.sort((a, b) => a.load - b.load);
  return capable[0]?.id ?? null;
}

export interface NewTask {
  objectiveId: string;
  /** null untuk task strategis (framing, konsultasi, keputusan) yang mendahului project. */
  projectId: string | null;
  kind: TaskKind;
  title: string;
  instructions: string;
  roleId: string;
  planKey: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  retryOfTaskId?: string;
  requestedBy: Actor;
}

/** Task baru selalu `pending`; promoteReadyTasks yang memasukkannya ke antrean. */
export async function insertTask(tx: Tx, emit: Emit, t: NewTask) {
  const id = randomUUID();
  await tx.insert(tasks).values({
    id,
    objectiveId: t.objectiveId,
    projectId: t.projectId,
    kind: t.kind,
    planKey: t.planKey,
    title: t.title,
    instructions: t.instructions,
    input: t.input ?? {},
    requiredRoleId: t.roleId,
    status: 'pending',
    timeoutMs: kindSpec(t.kind).timeoutMs,
    retryOfTaskId: t.retryOfTaskId ?? null,
    requestedBy: t.requestedBy,
  });
  if (t.dependsOn?.length) {
    await tx.insert(taskDependencies).values(t.dependsOn.map((d) => ({ taskId: id, dependsOn: d })));
  }
  emit({
    type: 'task.created',
    entityType: 'task',
    entityId: id,
    objectiveId: t.objectiveId,
    actor: t.requestedBy,
    payload: { title: t.title, kind: t.kind, planKey: t.planKey, dependsOn: t.dependsOn ?? [] },
  });
  return id;
}

/**
 * Task `pending` milik objective yang semua dependency-nya selesai: assign ke agent
 * yang mampu lalu masukkan ke antrean. Tanpa agent yang cocok, task tetap menunggu
 * dan muncul di inbox Owner (DESIGN.md §6.4).
 */
export async function promoteReadyTasks(ctx: OfficeContext, tx: Tx, emit: Emit, objectiveId: string) {
  const pending = await tx.select().from(tasks).where(and(eq(tasks.objectiveId, objectiveId), eq(tasks.status, 'pending')));
  if (pending.length === 0) return;
  const deps = await tx
    .select({ taskId: taskDependencies.taskId, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
    .where(inArray(taskDependencies.taskId, pending.map((t) => t.id)));

  for (const t of pending) {
    if (deps.some((d) => d.taskId === t.id && d.status !== 'completed')) continue;
    const agentId = t.assignedAgentId ?? (t.requiredRoleId ? await pickAgent(ctx, tx, t.requiredRoleId, t.kind) : null);
    if (!agentId) {
      if (!t.error) {
        await tx.update(tasks).set({ error: `Belum ada agent aktif untuk role ${t.requiredRoleId}` }).where(eq(tasks.id, t.id));
        emit({ type: 'task.unassignable', entityType: 'task', entityId: t.id, objectiveId: t.objectiveId, actor: 'orchestrator', payload: { requiredRoleId: t.requiredRoleId } });
      }
      continue;
    }
    await tx.update(tasks).set({ status: 'queued', queuedAt: new Date(), assignedAgentId: agentId, error: null }).where(eq(tasks.id, t.id));
    emit({ type: 'task.assigned', entityType: 'task', entityId: t.id, objectiveId: t.objectiveId, actor: 'orchestrator', payload: { agentId, title: t.title } });
  }
}

export type ObjectiveMode = 'strategic' | 'planned' | 'direct';

export interface CreateObjectiveInput {
  title: string;
  description?: string;
  /**
   * strategic: CEO + konsultasi eksekutif → keputusan → persetujuan Owner → Manager.
   * planned: Manager menyusun rencana + review. direct: satu task untuk Content Writer (hemat kuota).
   */
  mode?: ObjectiveMode;
}

/**
 * Objective → project. Strategic loop CEO (Slice 3) belum ada, jadi keputusan
 * dibuat langsung oleh Owner; Manager yang merencanakan eksekusinya.
 */
export async function createObjective(ctx: OfficeContext, input: CreateObjectiveInput) {
  return withTx(ctx, async (tx, emit) => {
    const mode = input.mode ?? 'planned';
    const objectiveId = randomUUID();
    const decisionId = randomUUID();
    const projectId = randomUUID();
    const description = input.description?.trim() || input.title;

    await tx.insert(objectives).values({ id: objectiveId, title: input.title, description, status: 'new', constraints: { mode } });
    emit({ type: 'objective.created', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner', payload: { title: input.title, mode } });

    if (mode === 'strategic') {
      const taskId = await startStrategicLoop(tx, emit, objectiveId);
      await promoteReadyTasks(ctx, tx, emit, objectiveId);
      return { objectiveId, projectId: null, taskId };
    }

    await tx.insert(decisions).values({
      id: decisionId,
      objectiveId,
      status: 'approved',
      proposedBy: 'owner',
      reviewedAt: new Date(),
      content: {
        strategy:
          mode === 'direct'
            ? 'Mode cepat: langsung dikerjakan Content Writer tanpa perencanaan dan review.'
            : 'Manager menyusun rencana, tim mengerjakan, Manager mereview.',
      },
    });
    emit({ type: 'decision.approved', entityType: 'decision', entityId: decisionId, objectiveId, actor: 'owner' });

    await tx.insert(projects).values({ id: projectId, objectiveId, decisionId, title: input.title, status: 'active' });
    emit({ type: 'project.created', entityType: 'project', entityId: projectId, objectiveId, actor: 'orchestrator' });

    const taskId =
      mode === 'direct'
        ? await insertTask(tx, emit, {
            objectiveId, projectId, kind: 'work', title: input.title, instructions: description,
            roleId: 'content_writer', planKey: 'main', requestedBy: 'owner',
          })
        : await insertTask(tx, emit, {
            objectiveId, projectId, kind: 'planning', title: `Rencana: ${input.title}`, instructions: planningInstructions(await loadPlannableRoles(tx)),
            roleId: 'manager', planKey: 'plan', requestedBy: 'owner',
          });
    await promoteReadyTasks(ctx, tx, emit, objectiveId);

    Objective.assert('new', 'active');
    await tx.update(objectives).set({ status: 'active', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
    emit({ type: 'objective.activated', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator' });

    return { objectiveId, projectId, taskId };
  });
}

/** Playbook eksekusi: reaksi deterministik saat task selesai (DESIGN.md §4.4). */
export async function onTaskCompleted(ctx: OfficeContext, tx: Tx, emit: Emit, task: TaskRow, result: unknown) {
  if (task.projectId) {
    if (task.kind === 'planning') await materializePlan(tx, emit, task, result as Plan);
    if (task.kind === 'review') await handleReview(tx, emit, task, result as Review);
  }
  if (task.kind === 'research') {
    const items = (result as { knowledge?: KnowledgeInput[] }).knowledge ?? [];
    await upsertKnowledge(tx, emit, items, { taskId: task.id, objectiveId: task.objectiveId, actor: `agent:${task.assignedAgentId}` });
  }
  if (!task.projectId) {
    if (task.kind === 'framing') await onFramingCompleted(tx, emit, task, result as Framing);
    if (task.kind === 'decision') await onDecisionCompleted(ctx, tx, emit, task, result as DecisionProposal);
  }
  await promoteReadyTasks(ctx, tx, emit, task.objectiveId);
  await onTaskFinished(tx, emit, task);
}

/** Task gagal atau dibatalkan: task yang bergantung padanya tidak mungkin jalan, jadi ikut dibatalkan. */
export async function onTaskAborted(tx: Tx, emit: Emit, task: TaskRow) {
  let blocked = [task.id];
  while (blocked.length > 0) {
    const dependents = await tx
      .select({ id: tasks.id, objectiveId: tasks.objectiveId })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(inArray(taskDependencies.dependsOn, blocked), eq(tasks.status, 'pending')));
    blocked = [];
    for (const d of dependents) {
      await tx.update(tasks).set({ status: 'cancelled', error: 'Dependency gagal atau dibatalkan', completedAt: new Date() }).where(eq(tasks.id, d.id));
      emit({ type: 'task.cancelled', entityType: 'task', entityId: d.id, objectiveId: d.objectiveId, actor: 'orchestrator', payload: { reason: 'dependency' } });
      blocked.push(d.id);
    }
  }
  await onTaskFinished(tx, emit, task);
}

async function materializePlan(tx: Tx, emit: Emit, planning: TaskRow, plan: Plan) {
  await tx.update(projects).set({ planTemplate: plan }).where(eq(projects.id, planning.projectId!));
  const actor: Actor = `agent:${planning.assignedAgentId}`;
  await createPlanTasks(tx, emit, { objectiveId: planning.objectiveId, projectId: planning.projectId!, actor }, plan, true);
  emit({ type: 'plan.created', entityType: 'project', entityId: planning.projectId!, objectiveId: planning.objectiveId, actor, payload: { tasks: plan.tasks.length, summary: plan.summary } });
}

/**
 * Buat task dari rencana (urutan topologis, dependency per key), ditutup task review.
 * Dipakai saat Manager selesai merencanakan dan saat scheduler mengulang run.
 */
export async function createPlanTasks(
  tx: Tx,
  emit: Emit,
  target: { objectiveId: string; projectId: string; actor: Actor },
  plan: Plan,
  withReview: boolean,
) {
  const ordered = topoOrder(plan);
  if (!ordered) throw new Error('Rencana tidak valid (siklus) lolos validasi');
  const kindOf = new Map((await loadPlannableRoles(tx)).map((r) => [r.id, r.kind]));
  const idByKey = new Map<string, string>();
  for (const t of ordered) {
    const kind = kindOf.get(t.role);
    if (!kind) throw new Error(`Role ${t.role} tidak lagi tersedia untuk rencana`);
    const id = await insertTask(tx, emit, {
      objectiveId: target.objectiveId,
      projectId: target.projectId,
      kind,
      title: t.title,
      instructions: t.instructions,
      roleId: t.role,
      planKey: t.key,
      dependsOn: t.depends_on.map((k) => idByKey.get(k)!),
      requestedBy: target.actor,
    });
    idByKey.set(t.key, id);
  }
  if (!withReview) return;
  const planKeys = plan.tasks.map((t) => t.key);
  await insertTask(tx, emit, {
    objectiveId: target.objectiveId,
    projectId: target.projectId,
    kind: 'review',
    title: 'Review hasil',
    instructions: reviewInstructions(plan.review_focus, 1),
    roleId: 'manager',
    planKey: 'review-1',
    input: { planKeys, reviewFocus: plan.review_focus, round: 1 },
    dependsOn: [...idByKey.values()],
    requestedBy: target.actor,
  });
}

/** Versi terbaru setiap plan key (revisi memakai key yang sama). */
async function latestByPlanKey(tx: Tx, projectId: string, keys: string[]) {
  const rows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.planKey, keys)))
    .orderBy(asc(tasks.createdAt));
  const latest = new Map<string, TaskRow>();
  for (const r of rows) latest.set(r.planKey!, r);
  return latest;
}

async function handleReview(tx: Tx, emit: Emit, review: TaskRow, result: Review) {
  const input = review.input as { planKeys: string[]; reviewFocus: string; round: number };
  const base = { entityType: 'project', entityId: review.projectId!, objectiveId: review.objectiveId, actor: `agent:${review.assignedAgentId}` as Actor };

  if (result.verdict === 'accept') {
    emit({ ...base, type: 'review.accepted', payload: { round: input.round, feedback: result.feedback } });
    return;
  }
  if (input.round > MAX_REVISION_ROUNDS) {
    // Batas revisi tercapai: hasil terakhir dipakai, keputusan akhir diserahkan ke Owner.
    emit({ ...base, type: 'review.escalated', payload: { round: input.round, feedback: result.feedback } });
    return;
  }

  const latest = await latestByPlanKey(tx, review.projectId!, input.planKeys);
  const revisedIds = new Map<string, string>();
  for (const r of result.revisions) {
    const orig = latest.get(r.task_key);
    if (!orig || revisedIds.has(r.task_key)) continue;
    const id = await insertTask(tx, emit, {
      objectiveId: orig.objectiveId,
      projectId: orig.projectId!,
      kind: orig.kind as TaskKind,
      title: `${orig.title.replace(/ \(revisi \d+\)$/, '')} (revisi ${input.round})`,
      instructions: revisionInstructions(orig.instructions, result.feedback, r.instructions, r.task_key),
      roleId: orig.requiredRoleId!,
      planKey: r.task_key,
      dependsOn: [orig.id],
      retryOfTaskId: orig.id,
      requestedBy: base.actor,
    });
    revisedIds.set(r.task_key, id);
  }
  const nextRound = input.round + 1;
  await insertTask(tx, emit, {
    objectiveId: review.objectiveId,
    projectId: review.projectId!,
    kind: 'review',
    title: `Review hasil (putaran ${nextRound})`,
    instructions: reviewInstructions(input.reviewFocus, nextRound),
    roleId: 'manager',
    planKey: `review-${nextRound}`,
    input: { ...input, round: nextRound },
    dependsOn: input.planKeys.map((k) => revisedIds.get(k) ?? latest.get(k)!.id),
    requestedBy: base.actor,
  });
  emit({ ...base, type: 'review.revision_requested', payload: { round: input.round, tasks: [...revisedIds.keys()], feedback: result.feedback } });
}

/**
 * Project dan objective ditutup saat semua task-nya terminal.
 * (Recurring objective: Phase 7.)
 */
export async function onTaskFinished(tx: Tx, emit: Emit, task: { projectId: string | null; objectiveId: string }) {
  if (!task.projectId) return onStrategicTaskFinished(tx, emit, task.objectiveId);
  const rows = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.projectId, task.projectId));
  const statuses = rows.map((r) => r.status as TaskStatus);
  const terminal = ['completed', 'failed', 'cancelled'];
  if (!statuses.every((s) => terminal.includes(s))) return;

  const outcome: ProjectStatus & ObjectiveStatus = statuses.includes('failed')
    ? 'failed'
    : statuses.every((s) => s === 'completed')
      ? 'completed'
      : 'cancelled';

  const [project] = await tx.select().from(projects).where(eq(projects.id, task.projectId));
  if (project && project.status === 'active') {
    Project.assert('active', outcome);
    await tx.update(projects).set({ status: outcome }).where(eq(projects.id, project.id));
    emit({ type: `project.${outcome}`, entityType: 'project', entityId: project.id, objectiveId: task.objectiveId, actor: 'orchestrator' });
  }

  const open = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.objectiveId, task.objectiveId), eq(projects.status, 'active')));
  const [objective] = await tx.select().from(objectives).where(eq(objectives.id, task.objectiveId));
  // Objective berulang tetap aktif; setiap run adalah project tersendiri (DESIGN.md §24).
  const [recurring] = await tx.select({ id: schedules.id }).from(schedules).where(and(eq(schedules.objectiveId, task.objectiveId), eq(schedules.enabled, true)));
  if (objective && open.length === 0 && objective.status === 'active' && !recurring) {
    Objective.assert('active', outcome);
    await tx.update(objectives).set({ status: outcome, updatedAt: new Date() }).where(eq(objectives.id, objective.id));
    emit({ type: `objective.${outcome}`, entityType: 'objective', entityId: objective.id, objectiveId: objective.id, actor: 'orchestrator' });
  }
}

/** Coba lagi semua task yang menunggu agent (mis. setelah provider dipasang atau agent diaktifkan). */
export async function promoteAllObjectives(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    const open = await tx
      .selectDistinct({ objectiveId: tasks.objectiveId })
      .from(tasks)
      .where(eq(tasks.status, 'pending'));
    for (const o of open) await promoteReadyTasks(ctx, tx, emit, o.objectiveId);
  });
}
