import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  CONSULTABLE_ROLES,
  ROLES,
  consultationInstructions,
  decisionInstructions,
  executionPlanningInstructions,
  framingInstructions,
} from '../agents/roles';
import type { DecisionProposal, Framing } from '../agents/schemas';
import type { Tx } from '../db/client';
import { agents, decisions, objectives, projects, roles, taskDependencies, tasks } from '../db/schema';
import { Decision, Objective, UserError, type Actor, type DecisionStatus, type ObjectiveStatus } from '../domain';
import type { RuntimeId } from '../runtimes/runtime';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';
import { insertTask, promoteReadyTasks } from './office';
import { hireAgent, loadPlannableRoles } from './org';
import { getSetting } from './settings';

type TaskRow = typeof tasks.$inferSelect;

/**
 * Strategic loop (DESIGN.md §4.4): CEO framing → konsultasi selektif → usulan keputusan
 * → persetujuan Owner → Manager. Dijalankan sekali per objective, bukan per task.
 */
export async function startStrategicLoop(tx: Tx, emit: Emit, objectiveId: string) {
  Objective.assert('new', 'strategizing');
  await tx.update(objectives).set({ status: 'strategizing', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
  emit({ type: 'objective.strategizing', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator' });
  return insertTask(tx, emit, {
    objectiveId,
    projectId: null,
    kind: 'framing',
    title: 'Kerangka strategi',
    instructions: framingInstructions(),
    roleId: 'ceo',
    planKey: 'framing',
    requestedBy: 'owner',
  });
}

export async function onFramingCompleted(tx: Tx, emit: Emit, framing: TaskRow, result: Framing) {
  const actor: Actor = `agent:${framing.assignedAgentId}`;
  // R&D lebih dulu bila diminta: CFO/CTO/HRD menimbang dengan evidence-nya.
  const research = result.questions.find((q) => CONSULTABLE_ROLES[q.to]!.kind === 'research');
  const researchId = research
    ? await insertTask(tx, emit, {
        objectiveId: framing.objectiveId,
        projectId: null,
        kind: 'research',
        title: 'Riset untuk CEO',
        instructions: consultationInstructions(research.question, result.vision),
        roleId: research.to,
        planKey: `consult-${research.to}`,
        requestedBy: actor,
      })
    : null;

  const consultIds = researchId ? [researchId] : [];
  for (const q of result.questions) {
    if (q === research) continue;
    const role = ROLES.find((r) => r.id === q.to)!;
    consultIds.push(
      await insertTask(tx, emit, {
        objectiveId: framing.objectiveId,
        projectId: null,
        kind: 'consultation',
        title: `Konsultasi ${role.name}`,
        instructions: consultationInstructions(q.question, result.vision),
        roleId: q.to,
        planKey: `consult-${q.to}`,
        dependsOn: researchId ? [researchId] : [],
        requestedBy: actor,
      }),
    );
  }

  await insertTask(tx, emit, {
    objectiveId: framing.objectiveId,
    projectId: null,
    kind: 'decision',
    title: 'Keputusan strategis',
    instructions: decisionInstructions(),
    roleId: 'ceo',
    planKey: 'decision-1',
    input: { round: 1 },
    // Framing ikut sebagai dependency agar visi CEO terbawa ke sesi keputusan.
    dependsOn: [framing.id, ...consultIds],
    requestedBy: actor,
  });
  emit({
    type: 'strategy.consultations_requested',
    entityType: 'objective',
    entityId: framing.objectiveId,
    objectiveId: framing.objectiveId,
    actor,
    payload: { roles: result.questions.map((q) => q.to) },
  });
}

/** Permintaan yang selalu butuh Owner, walau mode persetujuan otomatis (DESIGN.md §7, lapis 3). */
const needsOwner = (p: DecisionProposal) => p.owner_requests.some((r) => r.type !== 'other');

export async function onDecisionCompleted(ctx: OfficeContext, tx: Tx, emit: Emit, task: TaskRow, proposal: DecisionProposal) {
  const id = randomUUID();
  await tx.insert(decisions).values({
    id,
    objectiveId: task.objectiveId,
    taskId: task.id,
    content: proposal,
    status: 'proposed',
    proposedBy: `agent:${task.assignedAgentId}`,
  });
  await setObjectiveStatus(tx, task.objectiveId, 'strategizing', 'awaiting_approval');
  emit({ type: 'decision.proposed', entityType: 'decision', entityId: id, objectiveId: task.objectiveId, actor: `agent:${task.assignedAgentId}`, payload: { strategy: proposal.strategy, requests: proposal.owner_requests.length } });

  if ((await getSetting(tx, 'decision_approval')) === 'auto' && !needsOwner(proposal)) {
    await approveTx(ctx, tx, emit, id, 'Disetujui otomatis (mode persetujuan: otomatis).', 'orchestrator');
  }
}

async function setObjectiveStatus(tx: Tx, objectiveId: string, from: ObjectiveStatus, to: ObjectiveStatus) {
  const [o] = await tx.select().from(objectives).where(eq(objectives.id, objectiveId));
  if (!o || o.status !== from) throw new UserError(`Objective sedang berstatus ${o?.status ?? 'tidak ada'}, bukan ${from}`);
  Objective.assert(from, to);
  await tx.update(objectives).set({ status: to, updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
}

async function loadProposed(tx: Tx, decisionId: string) {
  const [d] = await tx.select().from(decisions).where(eq(decisions.id, decisionId));
  if (!d) throw new UserError('Keputusan tidak ditemukan');
  if (d.status !== 'proposed') throw new UserError(`Keputusan sudah berstatus ${d.status}`);
  return d;
}

async function setDecisionStatus(tx: Tx, id: string, from: DecisionStatus, to: DecisionStatus, note?: string) {
  Decision.assert(from, to);
  await tx.update(decisions).set({ status: to, reviewedAt: new Date(), reviewNote: note ?? null }).where(eq(decisions.id, id));
}

/**
 * Terapkan keputusan: tim, budget, lalu serahkan ke Manager. Agent baru hanya dari role
 * yang sudah ada (DESIGN.md A6). Runtime yang belum dikonfigurasi → agent menunggu provider.
 */
async function approveTx(ctx: OfficeContext, tx: Tx, emit: Emit, decisionId: string, note: string | undefined, actor: Actor) {
  const d = await loadProposed(tx, decisionId);
  const proposal = d.content as DecisionProposal;

  const previous = await tx.select().from(decisions).where(and(eq(decisions.objectiveId, d.objectiveId), eq(decisions.status, 'approved')));
  for (const p of previous) {
    await setDecisionStatus(tx, p.id, 'approved', 'superseded');
    emit({ type: 'decision.superseded', entityType: 'decision', entityId: p.id, objectiveId: d.objectiveId, actor });
  }
  await setDecisionStatus(tx, d.id, 'proposed', 'approved', note);
  emit({ type: 'decision.approved', entityType: 'decision', entityId: d.id, objectiveId: d.objectiveId, actor, payload: { note } });

  for (const member of proposal.team) {
    const [role] = await tx.select().from(roles).where(eq(roles.id, member.role));
    if (!role) continue;
    const runtime = member.runtime as RuntimeId;
    const existing = await tx.select().from(agents).where(and(eq(agents.roleId, role.id), ne(agents.status, 'inactive')));
    if (existing.length === 0) {
      await hireAgent(ctx, tx, emit, { roleId: role.id, runtime, actor, createdBy: `decision:${d.id}`, reason: member.reason, objectiveId: d.objectiveId });
    } else {
      const a = existing[0]!;
      if (a.runtime === runtime) continue;
      if (!ctx.runtimes.has(effectiveRuntime(ctx, runtime))) {
        // Jangan mematikan agent yang sedang bisa bekerja hanya karena provider belum ada.
        emit({ type: 'team.change_pending', entityType: 'agent', entityId: a.id, objectiveId: d.objectiveId, actor, payload: { name: a.name, runtime, reason: `Provider ${runtime} belum dipasang` } });
        continue;
      }
      await tx.update(agents).set({ runtime, model: null }).where(eq(agents.id, a.id));
      emit({ type: 'agent.updated', entityType: 'agent', entityId: a.id, objectiveId: d.objectiveId, actor, payload: { name: a.name, runtime, reason: member.reason } });
    }
  }

  if (proposal.budget_cap_usd > 0) {
    await tx.update(objectives).set({ budgetUsdMicros: Math.round(proposal.budget_cap_usd * 1_000_000) }).where(eq(objectives.id, d.objectiveId));
  }

  const [objective] = await tx.select().from(objectives).where(eq(objectives.id, d.objectiveId));
  const projectId = randomUUID();
  await tx.insert(projects).values({ id: projectId, objectiveId: d.objectiveId, decisionId: d.id, title: objective!.title, status: 'active' });
  emit({ type: 'project.created', entityType: 'project', entityId: projectId, objectiveId: d.objectiveId, actor: 'orchestrator' });
  await insertTask(tx, emit, {
    objectiveId: d.objectiveId,
    projectId,
    kind: 'planning',
    title: `Rencana: ${objective!.title}`,
    instructions: executionPlanningInstructions(proposal, await loadPlannableRoles(tx)),
    roleId: 'manager',
    planKey: 'plan',
    requestedBy: actor,
  });
  await setObjectiveStatus(tx, d.objectiveId, 'awaiting_approval', 'active');
  emit({ type: 'objective.activated', entityType: 'objective', entityId: d.objectiveId, objectiveId: d.objectiveId, actor: 'orchestrator' });
  await promoteReadyTasks(ctx, tx, emit, d.objectiveId);
}

export async function approveDecision(ctx: OfficeContext, decisionId: string, note?: string) {
  await withTx(ctx, (tx, emit) => approveTx(ctx, tx, emit, decisionId, note, 'owner'));
}

/** Owner minta revisi: CEO membuat usulan baru dengan konsultasi yang sama + catatan Owner. */
export async function reviseDecision(ctx: OfficeContext, decisionId: string, note: string) {
  if (!note.trim()) throw new UserError('Catatan revisi wajib diisi');
  await withTx(ctx, async (tx, emit) => {
    const d = await loadProposed(tx, decisionId);
    await setDecisionStatus(tx, d.id, 'proposed', 'rejected', note);
    const [prev] = d.taskId ? await tx.select().from(tasks).where(eq(tasks.id, d.taskId)) : [];
    const deps = prev ? await tx.select().from(taskDependencies).where(eq(taskDependencies.taskId, prev.id)) : [];
    const round = ((prev?.input as { round?: number } | undefined)?.round ?? 1) + 1;
    await insertTask(tx, emit, {
      objectiveId: d.objectiveId,
      projectId: null,
      kind: 'decision',
      title: `Keputusan strategis (revisi ${round - 1})`,
      instructions: decisionInstructions(note),
      roleId: 'ceo',
      planKey: `decision-${round}`,
      input: { round, previousDecision: d.content },
      dependsOn: deps.map((x) => x.dependsOn),
      retryOfTaskId: prev?.id,
      requestedBy: 'owner',
    });
    await setObjectiveStatus(tx, d.objectiveId, 'awaiting_approval', 'strategizing');
    emit({ type: 'decision.revision_requested', entityType: 'decision', entityId: d.id, objectiveId: d.objectiveId, actor: 'owner', payload: { note } });
    await promoteReadyTasks(ctx, tx, emit, d.objectiveId);
  });
}

export async function rejectDecision(ctx: OfficeContext, decisionId: string, note?: string) {
  await withTx(ctx, async (tx, emit) => {
    const d = await loadProposed(tx, decisionId);
    await setDecisionStatus(tx, d.id, 'proposed', 'rejected', note);
    await setObjectiveStatus(tx, d.objectiveId, 'awaiting_approval', 'cancelled');
    emit({ type: 'decision.rejected', entityType: 'decision', entityId: d.id, objectiveId: d.objectiveId, actor: 'owner', payload: { note } });
    emit({ type: 'objective.cancelled', entityType: 'objective', entityId: d.objectiveId, objectiveId: d.objectiveId, actor: 'owner' });
  });
}

/** Task strategis gagal/dibatalkan dan tidak ada lagi yang berjalan → objective gagal/dibatalkan. */
export async function onStrategicTaskFinished(tx: Tx, emit: Emit, objectiveId: string) {
  const [o] = await tx.select().from(objectives).where(eq(objectives.id, objectiveId));
  if (!o || o.status !== 'strategizing') return;
  const rows = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.objectiveId, objectiveId));
  if (rows.some((r) => ['pending', 'queued', 'running'].includes(r.status))) return;
  const outcome = rows.some((r) => r.status === 'failed') ? 'failed' : 'cancelled';
  Objective.assert('strategizing', outcome);
  await tx.update(objectives).set({ status: outcome, updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
  emit({ type: `objective.${outcome}`, entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator' });
}

