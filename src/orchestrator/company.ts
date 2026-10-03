import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { type CompanyBrief, agendaInstructions, companyBriefText } from '../agents/roles';
import type { Agenda, AgendaInput } from '../agents/schemas';
import type { Tx } from '../db/client';
import { agentSessions, agents, objectives, tasks } from '../db/schema';
import { Objective, UserError, type Actor } from '../domain';
import { type Emit, type OfficeContext, withTx } from './context';
import { createObjectiveIn, insertTask, promoteAllObjectives } from './office';
import { loadPlannableRoles } from './org';
import { quotaUsage } from './quota';
import { listResults } from './results';
import { getSetting, setSetting } from './settings';

/**
 * Piagam perusahaan: Owner hanya mengisi ini. Sisanya (apa yang dikerjakan, siapa yang direkrut,
 * kapan) diputuskan perusahaan sendiri selama masih dalam batas.
 */
export interface Company extends CompanyBrief {
  /** Batas biaya API berbayar per bulan (USD). 0 = tidak memakai API berbayar. */
  monthlyBudgetUsd: number;
  /** Objective buatan perusahaan yang boleh berjalan bersamaan. */
  maxActiveObjectives: number;
  /** Objective baru maksimum per agenda CEO. */
  maxNewPerCycle: number;
  /** Jeda minimal antar agenda saat masih ada pekerjaan berjalan. */
  cycleHours: number;
  /** Boleh mempublikasikan ke kanal publik tanpa menunggu Owner. */
  autoPublish: boolean;
  running: boolean;
  pausedReason: string | null;
  lastAgendaAt: string | null;
}

export const COMPANY_LIMITS = { maxActive: [1, 5], maxNew: [1, 5], cycleHours: [1, 168], budget: [0, 100000] } as const;
const IDLE_GAP_MS = 30 * 60_000;
const QUOTA_RESERVE = 0.8;

export type CompanyInput = Pick<Company, 'name' | 'businessType' | 'product' | 'audience' | 'guidelines' | 'forbidden' | 'monthlyBudgetUsd' | 'maxActiveObjectives' | 'maxNewPerCycle' | 'cycleHours' | 'autoPublish'>;

export const getCompany = (db: Tx) => getSetting(db, 'company');

export async function saveCompany(ctx: OfficeContext, input: CompanyInput) {
  if (input.businessType.trim().length < 3) throw new UserError('Jenis usaha wajib diisi');
  if (input.product.trim().length < 3) throw new UserError('Produk wajib diisi');
  await withTx(ctx, async (tx, emit) => {
    const prev = await getCompany(tx);
    const next: Company = {
      ...input,
      name: input.name.trim(),
      businessType: input.businessType.trim(),
      product: input.product.trim(),
      audience: input.audience.trim(),
      guidelines: input.guidelines.trim(),
      forbidden: input.forbidden.trim(),
      running: prev?.running ?? false,
      pausedReason: prev?.pausedReason ?? null,
      lastAgendaAt: prev?.lastAgendaAt ?? null,
    };
    await setSetting(tx, 'company', next);
    emit({ type: 'company.updated', entityType: 'company', entityId: 'company', actor: 'owner', payload: { businessType: next.businessType, product: next.product } });
  });
}

export async function setCompanyRunning(ctx: OfficeContext, running: boolean, opts: { actor?: Actor; reason?: string; now?: Date } = {}) {
  await withTx(ctx, async (tx, emit) => {
    const c = await getCompany(tx);
    if (!c) throw new UserError('Isi profil perusahaan dulu');
    await setSetting(tx, 'company', { ...c, running, pausedReason: running ? null : (opts.reason ?? null) });
    emit({ type: running ? 'company.started' : 'company.paused', entityType: 'company', entityId: 'company', actor: opts.actor ?? 'owner', payload: { reason: opts.reason } });
  });
}

export async function monthSpentUsd(db: Tx, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${agentSessions.costUsdMicros}), 0)`.mapWith(Number) })
    .from(agentSessions)
    .where(and(eq(agentSessions.costKind, 'actual'), gte(agentSessions.startedAt, start)));
  return (row?.total ?? 0) / 1_000_000;
}

const OPEN = ['new', 'strategizing', 'awaiting_approval', 'active'];
type ObjRow = typeof objectives.$inferSelect;
const originOf = (o: ObjRow) => (o.constraints as { source?: string; mode?: string }) ?? {};
const isAutopilot = (o: ObjRow) => originOf(o).source === 'autopilot';

/** Ringkasan perusahaan untuk prompt semua agent (null bila belum ada piagam). */
export async function companyBrief(db: Tx) {
  const c = await getCompany(db);
  return c ? companyBriefText(c) : null;
}

/**
 * Pengendali perusahaan otonom (deterministik): menjaga batas Owner dan memulai agenda CEO
 * saat perusahaan butuh pekerjaan berikutnya. LLM hanya memilih isi agenda; kapan, berapa banyak,
 * dan seberapa jauh ditentukan di sini.
 */
export async function reviewCompany(ctx: OfficeContext, now = new Date()) {
  const company = await getCompany(ctx.db);
  if (!company?.running) return;

  if (company.monthlyBudgetUsd > 0) {
    const spent = await monthSpentUsd(ctx.db, now);
    if (spent >= company.monthlyBudgetUsd) {
      await setCompanyRunning(ctx, false, { actor: 'orchestrator', reason: `Budget API bulan ini habis ($${spent.toFixed(2)} dari $${company.monthlyBudgetUsd.toFixed(2)})` });
      await withTx(ctx, async (_tx, emit) =>
        emit({ type: 'owner.notified', entityType: 'company', entityId: 'company', actor: 'orchestrator', payload: { title: 'Perusahaan dijeda: budget bulanan habis', message: `Terpakai $${spent.toFixed(2)} dari batas $${company.monthlyBudgetUsd.toFixed(2)}. Naikkan batas lalu mulai lagi bila ingin melanjutkan.` } }),
      );
      return;
    }
  }

  const quota = await quotaUsage(ctx, 'claude-cli');
  if (quota && quota.used >= quota.max * QUOTA_RESERVE) return; // sisakan kuota untuk pekerjaan yang sudah berjalan

  const open = (await ctx.db.select().from(objectives).where(inArray(objectives.status, OPEN))).filter(isAutopilot);
  if (open.some((o) => originOf(o).mode === 'agenda')) return;
  const room = company.maxActiveObjectives - open.length;
  if (room <= 0) return;

  const sinceLast = company.lastAgendaAt ? now.getTime() - Date.parse(company.lastAgendaAt) : Infinity;
  const gap = open.length === 0 ? IDLE_GAP_MS : company.cycleHours * 3600_000;
  if (sinceLast < gap) return;

  await startAgenda(ctx, company, Math.min(company.maxNewPerCycle, room), open, now);
}

async function startAgenda(ctx: OfficeContext, company: Company, maxNew: number, open: ObjRow[], now: Date) {
  const all = (await ctx.db.select().from(objectives)).filter(isAutopilot).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const finals = new Map((await listResults(ctx)).map((r) => [r.id, r.outputs.filter((o) => o.final).map((o) => o.summary ?? '').filter(Boolean).join(' ').slice(0, 300)]));
  const recent = all.filter((o) => originOf(o).mode !== 'agenda').slice(0, 12).map((o) => ({ title: o.title, status: o.status, summary: finals.get(o.id) ?? '' }));
  const openTitles = open.filter((o) => originOf(o).mode !== 'agenda').map((o) => o.title);
  const existingTitles = [...openTitles, ...recent.map((r) => r.title)];
  const spent = await monthSpentUsd(ctx.db, now);

  await withTx(ctx, async (tx, emit) => {
    const objectiveId = crypto.randomUUID();
    await tx.insert(objectives).values({
      id: objectiveId,
      title: `Agenda perusahaan ${now.toLocaleDateString('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      description: 'CEO menentukan pekerjaan berikutnya untuk perusahaan.',
      status: 'new',
      constraints: { mode: 'agenda', source: 'autopilot' },
    });
    emit({ type: 'objective.created', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator', payload: { mode: 'agenda', source: 'autopilot' } });
    Objective.assert('new', 'active');
    await tx.update(objectives).set({ status: 'active', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
    const plannable = await loadPlannableRoles(tx);
    const input: AgendaInput = { maxNew, existingTitles, forbidden: company.forbidden };
    await insertTask(tx, emit, {
      objectiveId,
      projectId: null,
      kind: 'agenda',
      title: 'Susun agenda perusahaan',
      instructions: agendaInstructions({ brief: company, maxNew, plannable, open: openTitles, recent, budget: { monthlyUsd: company.monthlyBudgetUsd, spentUsd: spent } }),
      input: { ...input },
      roleId: 'ceo',
      planKey: 'agenda',
      requestedBy: 'orchestrator',
    });
    await setSetting(tx, 'company', { ...company, lastAgendaAt: now.toISOString() });
    emit({ type: 'company.agenda_started', entityType: 'company', entityId: 'company', objectiveId, actor: 'orchestrator', payload: { maxNew } });
  });
  await promoteAllObjectives(ctx);
}

/** Agenda selesai: buat objective yang dipilih CEO dan tutup objective agenda. */
export async function onAgendaCompleted(ctx: OfficeContext, tx: Tx, emit: Emit, task: typeof tasks.$inferSelect, result: Agenda) {
  const { maxNew = 1 } = (task.input ?? {}) as Partial<AgendaInput>;
  const actor: Actor = `agent:${task.assignedAgentId}`;
  const created: string[] = [];
  for (const o of result.objectives.slice(0, maxNew)) {
    const r = await createObjectiveIn(ctx, tx, emit, { title: o.title, description: o.description, mode: 'planned' }, { actor: 'orchestrator', extra: { source: 'autopilot', agendaObjectiveId: task.objectiveId, rationale: o.rationale } });
    created.push(r.objectiveId);
  }
  for (const e of result.escalations) {
    emit({ type: 'owner.notified', entityType: 'company', entityId: 'company', objectiveId: task.objectiveId, actor: 'orchestrator', payload: { title: `CEO: ${e.title}`, message: e.message } });
  }
  Objective.assert('active', 'completed');
  await tx.update(objectives).set({ status: 'completed', updatedAt: new Date() }).where(eq(objectives.id, task.objectiveId));
  emit({ type: 'company.agenda_created', entityType: 'company', entityId: 'company', objectiveId: task.objectiveId, actor, payload: { assessment: result.assessment, objectives: result.objectives.map((o) => o.title), created: created.length, escalations: result.escalations.length } });
}

/** Agenda gagal atau dibatalkan: tutup objective agenda agar siklus berikutnya bisa mulai. */
export async function onAgendaAborted(tx: Tx, emit: Emit, objectiveId: string) {
  const [o] = await tx.select().from(objectives).where(eq(objectives.id, objectiveId));
  if (!o || o.status !== 'active' || originOf(o).mode !== 'agenda') return false;
  await tx.update(objectives).set({ status: 'failed', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
  emit({ type: 'objective.failed', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'orchestrator' });
  return true;
}

/** Status untuk halaman Perusahaan. */
export async function companyStatus(ctx: OfficeContext, now = new Date()) {
  const company = await getCompany(ctx.db);
  const all = (await ctx.db.select().from(objectives)).filter(isAutopilot).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const open = all.filter((o) => OPEN.includes(o.status));
  const quota = await quotaUsage(ctx, 'claude-cli');
  const spent = await monthSpentUsd(ctx.db, now);
  const openIds = open.map((o) => o.id);
  const stepRows = openIds.length
    ? await ctx.db
        .select({ task: tasks, agentName: agents.name })
        .from(tasks)
        .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
        .where(inArray(tasks.objectiveId, openIds))
        .orderBy(asc(tasks.createdAt))
    : [];
  // Satu langkah per plan key (versi terbaru), urut sesuai pembuatan.
  const stepsByObjective = new Map<string, { title: string; status: string; kind: string; agentName: string | null }[]>();
  for (const { task, agentName } of stepRows) {
    const list = stepsByObjective.get(task.objectiveId) ?? [];
    const i = task.planKey ? list.findIndex((x) => (x as { key?: string }).key === `${task.projectId}:${task.planKey}`) : -1;
    const entry = { title: task.title, status: task.status, kind: task.kind, agentName, key: task.planKey ? `${task.projectId}:${task.planKey}` : task.id };
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    stepsByObjective.set(task.objectiveId, list);
  }
  let nextAgendaAt: string | null = null;
  let waiting: string | null = null;
  if (company?.running) {
    const work = open.filter((o) => originOf(o).mode !== 'agenda');
    if (open.some((o) => originOf(o).mode === 'agenda')) waiting = 'CEO sedang menyusun agenda';
    else if (work.length >= company.maxActiveObjectives) waiting = `Menunggu pekerjaan berjalan selesai (${work.length}/${company.maxActiveObjectives})`;
    else if (quota && quota.used >= quota.max * QUOTA_RESERVE) waiting = `Menunggu kuota Claude (${quota.used}/${quota.max} run terpakai)`;
    if (company.lastAgendaAt) nextAgendaAt = new Date(Date.parse(company.lastAgendaAt) + (work.length === 0 ? IDLE_GAP_MS : company.cycleHours * 3600_000)).toISOString();
  }
  return {
    company,
    state: !company ? ('unset' as const) : company.running ? ('running' as const) : ('paused' as const),
    waiting,
    nextAgendaAt,
    spentUsd: spent,
    results: (await listResults(ctx)).filter((r) => all.some((o) => o.id === r.id)).slice(0, 6).flatMap((r) => r.outputs.filter((o) => o.final).map((o) => ({ objectiveId: r.id, title: o.title, summary: o.summary, status: r.status, at: o.completedAt }))).slice(0, 3),
    quota: quota ? { used: quota.used, max: quota.max } : null,
    objectives: all.slice(0, 20).map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      mode: originOf(o).mode ?? 'planned',
      createdAt: o.createdAt.toISOString(),
      steps: (stepsByObjective.get(o.id) ?? []).map((t) => ({ title: t.title, status: t.status, kind: t.kind, agentName: t.agentName })),
    })),
  };
}
