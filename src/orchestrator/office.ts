import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { INITIAL_AGENTS, ROLES } from '../agents/roles';
import { kindSpec } from '../agents/schemas';
import type { Tx } from '../db/client';
import { agents, decisions, objectives, projects, roles, tasks } from '../db/schema';
import { Objective, Project, type ObjectiveStatus, type ProjectStatus, type TaskStatus } from '../domain';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';

/** Isi role dan karyawan awal. Idempotent. */
export async function seedOrganization(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    for (const r of ROLES) {
      await tx
        .insert(roles)
        .values(r)
        .onDuplicateKeyUpdate({ set: { name: r.name, department: r.department, instructions: r.instructions, nativeTools: r.nativeTools } });
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

export interface CreateObjectiveInput {
  title: string;
  description?: string;
}

/**
 * Slice 1 playbook: objective langsung dieksekusi sebagai satu task `work`
 * untuk Content Writer. Strategic loop (CEO → konsultasi → keputusan) masuk di Slice 3.
 */
export async function createObjective(ctx: OfficeContext, input: CreateObjectiveInput) {
  return withTx(ctx, async (tx, emit) => {
    const objectiveId = randomUUID();
    const decisionId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const description = input.description?.trim() || input.title;

    await tx.insert(objectives).values({ id: objectiveId, title: input.title, description, status: 'new' });
    emit({ type: 'objective.created', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner', payload: { title: input.title } });

    await tx.insert(decisions).values({
      id: decisionId,
      objectiveId,
      status: 'approved',
      proposedBy: 'owner',
      reviewedAt: new Date(),
      content: { strategy: 'Eksekusi langsung oleh Content Writer (Slice 1, tanpa strategic loop).' },
    });
    emit({ type: 'decision.approved', entityType: 'decision', entityId: decisionId, objectiveId, actor: 'owner' });

    await tx.insert(projects).values({ id: projectId, objectiveId, decisionId, title: input.title, status: 'active' });
    emit({ type: 'project.created', entityType: 'project', entityId: projectId, objectiveId, actor: 'orchestrator' });

    const agentId = await pickAgent(ctx, tx, 'content_writer', 'work');
    const status: TaskStatus = agentId ? 'queued' : 'pending';
    await tx.insert(tasks).values({
      id: taskId,
      objectiveId,
      projectId,
      kind: 'work',
      title: input.title,
      instructions: description,
      requiredRoleId: 'content_writer',
      assignedAgentId: agentId,
      status,
      requestedBy: 'owner',
    });
    emit({ type: 'task.created', entityType: 'task', entityId: taskId, objectiveId, actor: 'orchestrator', payload: { title: input.title, kind: 'work' } });
    emit(
      agentId
        ? { type: 'task.assigned', entityType: 'task', entityId: taskId, objectiveId, actor: 'orchestrator', payload: { agentId } }
        : { type: 'task.unassignable', entityType: 'task', entityId: taskId, objectiveId, actor: 'orchestrator', payload: { requiredRoleId: 'content_writer' } },
    );

    Objective.assert('new', 'active');
    await tx.update(objectives).set({ status: 'active', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
    emit({ type: 'objective.activated', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator' });

    return { objectiveId, projectId, taskId };
  });
}

/**
 * Dipanggil setelah task mencapai status terminal. Project dan objective
 * ditutup saat semua task-nya terminal. (Recurring objective: Phase 7.)
 */
export async function onTaskFinished(tx: Tx, emit: Emit, task: { projectId: string | null; objectiveId: string }) {
  if (!task.projectId) return;
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
    .where(and(eq(projects.objectiveId, task.objectiveId), inArray(projects.status, ['active'])));
  const [objective] = await tx.select().from(objectives).where(eq(objectives.id, task.objectiveId));
  if (objective && open.length === 0 && objective.status === 'active') {
    Objective.assert('active', outcome);
    await tx.update(objectives).set({ status: outcome, updatedAt: new Date() }).where(eq(objectives.id, objective.id));
    emit({ type: `objective.${outcome}`, entityType: 'objective', entityId: objective.id, objectiveId: objective.id, actor: 'orchestrator' });
  }
}
