import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Plan } from '../agents/schemas';
import type { Tx } from '../db/client';
import { objectives, projects, schedules } from '../db/schema';
import { Objective, UserError } from '../domain';
import { type OfficeContext, withTx } from './context';
import { createPlanTasks, promoteReadyTasks } from './office';

export interface ScheduleInput {
  kind: 'daily' | 'interval';
  timeOfDay?: string;
  intervalHours?: number;
  timezone?: string;
  enabled?: boolean;
}

/** Selisih (ms) waktu lokal zona `tz` terhadap UTC pada saat `utcMs`. */
function tzOffsetMs(tz: string, utcMs: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - utcMs;
}

/** Waktu run berikutnya setelah `from` (deterministik, tanpa library). */
export function computeNextRun(s: ScheduleInput, from: Date): Date {
  if (s.kind === 'interval') return new Date(from.getTime() + (s.intervalHours ?? 24) * 3600_000);
  const tz = s.timezone ?? 'Asia/Jakarta';
  const [hh, mm] = (s.timeOfDay ?? '09:00').split(':').map(Number) as [number, number];
  const local = new Date(from.getTime() + tzOffsetMs(tz, from.getTime()));
  for (let addDays = 0; addDays <= 2; addDays++) {
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, hh, mm);
    const utc = guess - tzOffsetMs(tz, guess - tzOffsetMs(tz, guess));
    if (utc > from.getTime()) return new Date(utc);
  }
  throw new Error('Tidak bisa menghitung jadwal berikutnya');
}

function validate(input: ScheduleInput) {
  if (input.kind === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay ?? '')) throw new UserError('Jam harus berformat HH:MM');
  if (input.kind === 'interval' && !(input.intervalHours && input.intervalHours >= 1 && input.intervalHours <= 24 * 30)) {
    throw new UserError('Interval harus 1 jam sampai 30 hari');
  }
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw new UserError(`Zona waktu tidak dikenal: ${input.timezone}`);
    }
  }
}

export async function setSchedule(ctx: OfficeContext, objectiveId: string, input: ScheduleInput | null) {
  if (input) validate(input);
  await withTx(ctx, async (tx, emit) => {
    const [o] = await tx.select().from(objectives).where(eq(objectives.id, objectiveId));
    if (!o) throw new UserError('Objective tidak ditemukan');
    const [existing] = await tx.select().from(schedules).where(eq(schedules.objectiveId, objectiveId));
    if (!input) {
      if (existing) await tx.delete(schedules).where(eq(schedules.id, existing.id));
      emit({ type: 'schedule.removed', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner' });
      return;
    }
    if (['failed', 'cancelled'].includes(o.status)) throw new UserError('Objective yang gagal atau dibatalkan tidak bisa dijadwalkan');
    const values = {
      kind: input.kind,
      timeOfDay: input.kind === 'daily' ? input.timeOfDay! : null,
      intervalHours: input.kind === 'interval' ? input.intervalHours! : null,
      timezone: input.timezone ?? 'Asia/Jakarta',
      enabled: input.enabled ?? true,
      nextRunAt: computeNextRun(input, new Date()),
    };
    if (existing) await tx.update(schedules).set(values).where(eq(schedules.id, existing.id));
    else await tx.insert(schedules).values({ id: randomUUID(), objectiveId, ...values });
    if (o.status === 'completed' && values.enabled) {
      Objective.assert('completed', 'active');
      await tx.update(objectives).set({ status: 'active', updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
      emit({ type: 'objective.activated', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner', payload: { reason: 'schedule' } });
    }
    emit({ type: 'schedule.updated', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner', payload: { ...values, nextRunAt: values.nextRunAt.toISOString() } });
  });
}

/** Rencana yang dipakai ulang: rencana Manager terakhir, atau satu task untuk mode cepat. */
async function templateFor(tx: Tx, objective: typeof objectives.$inferSelect): Promise<{ plan: Plan; withReview: boolean } | null> {
  const [p] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.objectiveId, objective.id), isNotNull(projects.planTemplate)))
    .orderBy(desc(projects.createdAt))
    .limit(1);
  if (p?.planTemplate) return { plan: p.planTemplate as Plan, withReview: true };
  if ((objective.constraints as { mode?: string }).mode === 'direct') {
    return {
      plan: { summary: 'Mode cepat', review_focus: '', tasks: [{ key: 'main', title: objective.title, role: 'content_writer', instructions: objective.description, depends_on: [] }] },
      withReview: false,
    };
  }
  return null;
}

/** Jalankan jadwal yang jatuh tempo. Strategic loop dan perencanaan tidak diulang (DESIGN.md §24). */
export async function runDueSchedules(ctx: OfficeContext, now = new Date()) {
  const due = await ctx.db.select().from(schedules).where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));
  for (const s of due) {
    await withTx(ctx, async (tx, emit) => {
      const nextRunAt = computeNextRun({ kind: s.kind as 'daily' | 'interval', timeOfDay: s.timeOfDay ?? undefined, intervalHours: s.intervalHours ?? undefined, timezone: s.timezone }, now);
      await tx.update(schedules).set({ nextRunAt, lastRunAt: now }).where(eq(schedules.id, s.id));
      const base = { entityType: 'objective', entityId: s.objectiveId, objectiveId: s.objectiveId, actor: 'scheduler' as const };

      const [objective] = await tx.select().from(objectives).where(eq(objectives.id, s.objectiveId));
      if (!objective || objective.status !== 'active') {
        emit({ ...base, type: 'schedule.skipped', payload: { reason: `Objective berstatus ${objective?.status}` } });
        return;
      }
      const running = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.objectiveId, s.objectiveId), eq(projects.status, 'active')));
      if (running.length > 0) {
        emit({ ...base, type: 'schedule.skipped', payload: { reason: 'Run sebelumnya belum selesai' } });
        return;
      }
      const template = await templateFor(tx, objective);
      if (!template) {
        emit({ ...base, type: 'schedule.skipped', payload: { reason: 'Belum ada rencana kerja untuk diulang' } });
        return;
      }
      const projectId = randomUUID();
      const label = new Intl.DateTimeFormat('id-ID', { timeZone: s.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(now);
      await tx.insert(projects).values({ id: projectId, objectiveId: objective.id, title: `${objective.title} — ${label}`, planTemplate: template.withReview ? template.plan : null, status: 'active' });
      emit({ type: 'project.created', entityType: 'project', entityId: projectId, objectiveId: objective.id, actor: 'scheduler' });
      await createPlanTasks(tx, emit, { objectiveId: objective.id, projectId, actor: 'scheduler' }, template.plan, template.withReview);
      emit({ ...base, type: 'schedule.ran', payload: { projectId, nextRunAt: nextRunAt.toISOString() } });
      await promoteReadyTasks(ctx, tx, emit, objective.id);
    });
  }
  return due.length;
}
