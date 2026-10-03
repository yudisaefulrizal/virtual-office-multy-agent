import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { agentSessions, agents, objectives, roles, tasks } from '../db/schema';
import { UserError, type Actor } from '../domain';
import type { RuntimeId } from '../runtimes/runtime';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';
import { getAllSettings } from './settings';

/**
 * Siklus hidup agent (DESIGN.md §16):
 *   active ⇄ inactive (dirumahkan: identitas, riwayat, dan konfigurasi tetap, bisa dipakai ulang)
 *   inactive/active → retired (diarsipkan: tidak tampil di kantor, hanya diaktifkan kembali oleh keputusan eksplisit)
 *   waiting_provider: runtime belum siap; aktif otomatis saat provider dipasang.
 */
export const GONE = ['inactive', 'retired'] as const;
export type Lifecycle = 'suspend' | 'reactivate' | 'retire';

export const isGone = (status: string) => (GONE as readonly string[]).includes(status);

export async function setLifecycle(
  ctx: OfficeContext,
  tx: Tx,
  emit: Emit,
  input: { agentId: string; action: Lifecycle; actor: Actor; reason: string },
) {
  const [a] = await tx.select().from(agents).where(eq(agents.id, input.agentId));
  if (!a) throw new UserError('Agent tidak ditemukan');
  const [running] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.assignedAgentId, a.id), eq(tasks.status, 'running'))).limit(1);

  let next: string;
  if (input.action === 'reactivate') {
    if (!isGone(a.status)) throw new UserError(`${a.name} sudah aktif`);
    next = ctx.runtimes.has(effectiveRuntime(ctx, a.runtime as RuntimeId)) ? 'active' : 'waiting_provider';
  } else {
    if (running) throw new UserError(`${a.name} sedang bekerja; tunggu task-nya selesai`);
    if (a.status === 'retired') throw new UserError(`${a.name} sudah dipensiunkan`);
    if (input.action === 'suspend' && a.status === 'inactive') throw new UserError(`${a.name} sudah dirumahkan`);
    next = input.action === 'suspend' ? 'inactive' : 'retired';
  }
  await tx.update(agents).set({ status: next, statusChangedAt: new Date() }).where(eq(agents.id, a.id));
  const type = input.action === 'suspend' ? 'agent.suspended' : input.action === 'retire' ? 'agent.retired' : 'agent.reactivated';
  emit({ type, entityType: 'agent', entityId: a.id, actor: input.actor, payload: { name: a.name, roleId: a.roleId, status: next, reason: input.reason } });
  return { id: a.id, name: a.name, status: next };
}

/** Staf dirumahkan yang paling cocok dipakai ulang untuk role ini (runtime yang diminta dulu, lalu paling lama bekerja). */
export async function findReusable(tx: Tx, roleId: string, runtime?: string) {
  const rows = await tx.select().from(agents).where(and(eq(agents.roleId, roleId), eq(agents.status, 'inactive'))).orderBy(asc(agents.createdAt));
  return rows.find((a) => !runtime || a.runtime === runtime) ?? (runtime ? undefined : rows[0]);
}

const HOUR = 3600_000;

/**
 * Aturan HRD menurunkan staf (deterministik): staf tambahan yang menganggur lebih lama dari
 * `suspend_idle_minutes` dirumahkan selama role itu tidak punya antrean. Staf tertua tiap role
 * tetap aktif (fungsi inti terpenuhi), kecuali agent on_demand. Agent temporary dirumahkan begitu
 * objective-nya selesai. Tidak ada yang dihapus: bisa diaktifkan kembali kapan saja.
 */
export async function reviewDownsizing(ctx: OfficeContext, now = new Date()) {
  const settings = await getAllSettings(ctx.db);
  const all = await ctx.db.select().from(agents).where(notInArray(agents.status, [...GONE])).orderBy(asc(agents.createdAt));
  if (all.length === 0) return;
  const open = await ctx.db.select().from(tasks).where(inArray(tasks.status, ['pending', 'queued', 'running']));
  const busy = new Set(open.filter((t) => t.status === 'running').map((t) => t.assignedAgentId));
  const roleHasWork = new Set(open.map((t) => t.requiredRoleId).filter(Boolean) as string[]);
  const last = await ctx.db
    .select({ a: tasks.assignedAgentId, at: tasks.completedAt })
    .from(tasks)
    .where(and(eq(tasks.status, 'completed')))
    .orderBy(desc(tasks.completedAt));
  const lastDone = new Map<string, Date>();
  for (const r of last) if (r.a && r.at && !lastDone.has(r.a)) lastDone.set(r.a, r.at);
  const idleSince = (a: (typeof all)[number]) => new Date(Math.max(a.createdAt.getTime(), a.statusChangedAt?.getTime() ?? 0, lastDone.get(a.id)?.getTime() ?? 0));

  const finished = new Set(
    (await ctx.db.select({ id: objectives.id }).from(objectives).where(inArray(objectives.status, ['completed', 'failed', 'cancelled']))).map((o) => o.id),
  );
  const idleLimit = settings.suspend_idle_minutes * 60_000;
  const toSuspend: { agent: (typeof all)[number]; reason: string }[] = [];
  const oldestPerRole = new Map<string, string>();
  for (const a of all) if (a.status === 'active' && a.tenure !== 'on_demand' && a.tenure !== 'temporary' && !oldestPerRole.has(a.roleId)) oldestPerRole.set(a.roleId, a.id);

  for (const a of all) {
    if (a.status !== 'active' || busy.has(a.id) || open.some((t) => t.assignedAgentId === a.id)) continue;
    if (a.tenure === 'temporary' && a.tempObjectiveId && finished.has(a.tempObjectiveId)) {
      toSuspend.push({ agent: a, reason: 'Objective yang dilayani sudah selesai' });
      continue;
    }
    if (!idleLimit || roleHasWork.has(a.roleId)) continue;
    const idleFor = now.getTime() - idleSince(a).getTime();
    if (idleFor < idleLimit) continue;
    if (a.tenure === 'on_demand') toSuspend.push({ agent: a, reason: `Agent on-demand menganggur ${Math.round(idleFor / 60_000)} menit` });
    else if (oldestPerRole.get(a.roleId) !== a.id) toSuspend.push({ agent: a, reason: `Kapasitas berlebih: menganggur ${Math.round(idleFor / 60_000)} menit` });
  }
  if (toSuspend.length === 0) return;
  await withTx(ctx, async (tx, emit) => {
    for (const { agent, reason } of toSuspend) {
      await setLifecycle(ctx, tx, emit, { agentId: agent.id, action: 'suspend', actor: 'orchestrator', reason: `HRD: ${reason}` }).catch(() => undefined);
    }
  });
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
  /** Task selesai yang kemudian direvisi Manager (proksi kualitas). */
  revised: number;
  retried: number;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  costKind: string | null;
  /** Porsi waktu bekerja dalam 7 hari terakhir (0–1). */
  utilization: number;
  lastActiveAt: string | null;
}

export interface Recommendation {
  agentId: string | null;
  roleId: string | null;
  level: 'info' | 'warn';
  text: string;
}

/** Data performa agent dan saran HRD (deterministik, dari data nyata). */
export async function agentPerformance(ctx: OfficeContext) {
  const db = ctx.db;
  const [agentRows, taskRows, sessionRows, roleRows] = await Promise.all([
    db.select().from(agents).orderBy(asc(agents.createdAt)),
    db.select().from(tasks),
    db.select().from(agentSessions),
    db.select().from(roles),
  ]);
  const weekAgo = Date.now() - 7 * 24 * HOUR;
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const newer = (t: (typeof taskRows)[number]) =>
    !!t.planKey && taskRows.some((o) => o.id !== t.id && o.projectId === t.projectId && o.planKey === t.planKey && o.createdAt > t.createdAt);

  const out: AgentPerformance[] = agentRows.map((a) => {
    const mine = taskRows.filter((t) => t.assignedAgentId === a.id);
    const done = mine.filter((t) => t.status === 'completed');
    const sessions = sessionRows.filter((s) => s.agentId === a.id);
    const durations = done.filter((t) => t.startedAt && t.completedAt).map((t) => t.completedAt!.getTime() - t.startedAt!.getTime());
    const busyMs = sessions.reduce((n, s) => {
      const end = (s.endedAt ?? new Date()).getTime();
      const start = Math.max(s.startedAt.getTime(), weekAgo);
      return n + Math.max(0, end - start);
    }, 0);
    const lastAt = [...done.map((t) => t.completedAt?.getTime() ?? 0)].sort((x, y) => y - x)[0];
    return {
      agentId: a.id,
      name: a.name,
      roleId: a.roleId,
      roleName: roleName.get(a.roleId) ?? a.roleId,
      status: a.status,
      tenure: a.tenure,
      runtime: a.runtime,
      model: a.model,
      tasksDone: done.length,
      tasksFailed: mine.filter((t) => t.status === 'failed').length,
      revised: done.filter((t) => (t.kind === 'work' || t.kind === 'research') && newer(t)).length,
      retried: mine.filter((t) => t.attempt > 1).length,
      avgDurationMs: durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : null,
      inputTokens: sessions.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
      outputTokens: sessions.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
      costUsdMicros: sessions.reduce((n, s) => n + (s.costUsdMicros ?? 0), 0),
      costKind: sessions.find((s) => s.costKind)?.costKind ?? null,
      utilization: Math.min(1, busyMs / (7 * 24 * HOUR)),
      lastActiveAt: lastAt ? new Date(lastAt).toISOString() : null,
    };
  });

  const recs: Recommendation[] = [];
  for (const p of out) {
    if (p.status === 'retired') continue;
    const total = p.tasksDone + p.tasksFailed;
    if (total >= 3 && p.tasksFailed / total >= 0.3) recs.push({ agentId: p.agentId, roleId: p.roleId, level: 'warn', text: `${p.name}: ${p.tasksFailed} dari ${total} task gagal. Periksa model/runtime atau instruksi role.` });
    if (p.tasksDone >= 3 && p.revised / p.tasksDone >= 0.5) recs.push({ agentId: p.agentId, roleId: p.roleId, level: 'warn', text: `${p.name}: ${p.revised} dari ${p.tasksDone} hasil harus direvisi. Pertimbangkan model yang lebih kuat.` });
  }
  // Perbandingan sesama role: kualitas setara, biaya jauh berbeda.
  for (const roleId of new Set(out.map((p) => p.roleId))) {
    const peers = out.filter((p) => p.roleId === roleId && p.status !== 'retired' && p.tasksDone >= 3 && p.costKind === 'actual');
    if (peers.length < 2) continue;
    const perTask = (p: AgentPerformance) => p.costUsdMicros / p.tasksDone;
    const sorted = [...peers].sort((x, y) => perTask(x) - perTask(y));
    const cheap = sorted[0]!;
    const costly = sorted.at(-1)!;
    if (perTask(costly) > perTask(cheap) * 1.5 && costly.revised / costly.tasksDone <= cheap.revised / cheap.tasksDone + 0.1) {
      recs.push({ agentId: costly.agentId, roleId, level: 'info', text: `${costly.name} ${Math.round((1 - perTask(cheap) / perTask(costly)) * 100)}% lebih mahal per task daripada ${cheap.name} dengan kualitas setara. Pertimbangkan memindahkannya ke model/runtime ${cheap.runtime}${cheap.model ? ` (${cheap.model})` : ''}.` });
    }
  }
  for (const p of out) {
    if (p.status === 'inactive') recs.push({ agentId: p.agentId, roleId: p.roleId, level: 'info', text: `${p.name} sedang dirumahkan. HRD memakainya kembali lebih dulu bila ${p.roleName} perlu tambahan staf.` });
  }
  return { agents: out, recommendations: recs };
}

/** Wrapper untuk Owner/UI: ubah siklus hidup lalu lanjutkan task yang tertahan. */
export async function changeAgentLifecycle(ctx: OfficeContext, agentId: string, action: Lifecycle, actor: Actor, reason: string, afterChange?: () => Promise<void>) {
  const result = await withTx(ctx, (tx, emit) => setLifecycle(ctx, tx, emit, { agentId, action, actor, reason }));
  await afterChange?.();
  return result;
}
