import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { objectives, projects, schedules, tasks } from '../src/db/schema';
import { createObjective } from '../src/orchestrator/office';
import { computeNextRun, runDueSchedules, setSchedule } from '../src/orchestrator/scheduler';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('computeNextRun', () => {
  const daily = { kind: 'daily' as const, timeOfDay: '09:00', timezone: 'Asia/Jakarta' };
  it('harian 09:00 WIB: hari yang sama bila belum lewat, besok bila sudah', () => {
    expect(computeNextRun(daily, new Date('2026-10-03T01:00:00Z')).toISOString()).toBe('2026-10-03T02:00:00.000Z');
    expect(computeNextRun(daily, new Date('2026-10-03T02:00:00Z')).toISOString()).toBe('2026-10-04T02:00:00.000Z');
    expect(computeNextRun(daily, new Date('2026-10-03T20:00:00Z')).toISOString()).toBe('2026-10-04T02:00:00.000Z');
  });
  it('zona waktu dengan DST tetap jatuh di jam lokal yang benar', () => {
    const ny = { kind: 'daily' as const, timeOfDay: '09:00', timezone: 'America/New_York' };
    expect(computeNextRun(ny, new Date('2026-07-01T00:00:00Z')).toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT
    expect(computeNextRun(ny, new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2026-12-01T14:00:00.000Z'); // EST
  });
  it('interval', () => {
    expect(computeNextRun({ kind: 'interval', intervalHours: 6 }, new Date('2026-10-03T00:00:00Z')).toISOString()).toBe('2026-10-03T06:00:00.000Z');
  });
});

describe('Objective berulang', () => {
  it('run terjadwal mengulang rencana Manager tanpa merencanakan ulang; objective tetap aktif', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    const { objectiveId } = await createObjective(o.ctx, { title: 'Konten harian', mode: 'planned' });
    await setSchedule(o.ctx, objectiveId, { kind: 'daily', timeOfDay: '09:00' });
    await o.worker.drain();

    const [after1] = await o.db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(after1?.status).toBe('active'); // tidak ditutup karena berulang
    const planningRuns = () => o.runtime.calls.filter((c) => Object.keys((c.outputSchema as any).properties).includes('tasks')).length;
    expect(planningRuns()).toBe(1);

    // Jadwal jatuh tempo.
    await o.db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.objectiveId, objectiveId));
    expect(await runDueSchedules(o.ctx)).toBe(1);
    await o.worker.drain();

    const ps = await o.db.select().from(projects).where(eq(projects.objectiveId, objectiveId));
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => p.status === 'completed')).toBe(true);
    expect(planningRuns()).toBe(1); // perencanaan tidak diulang
    const second = ps.find((p) => p.title.startsWith('Konten harian —'))!;
    const kinds = (await o.db.select().from(tasks).where(eq(tasks.projectId, second.id))).map((t) => t.kind).sort();
    expect(kinds).toEqual(['research', 'review', 'work']);
    const [s] = await o.db.select().from(schedules).where(eq(schedules.objectiveId, objectiveId));
    expect(s!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('run dilewati bila run sebelumnya masih berjalan', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    const { objectiveId } = await createObjective(o.ctx, { title: 'Cepat berulang', mode: 'direct' });
    await setSchedule(o.ctx, objectiveId, { kind: 'interval', intervalHours: 1 });
    await o.db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.objectiveId, objectiveId));
    await runDueSchedules(o.ctx); // project pertama masih aktif (belum di-drain)
    expect(o.emitted.some((e) => e.type === 'schedule.skipped')).toBe(true);
    await o.worker.drain();

    await o.db.update(schedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(schedules.objectiveId, objectiveId));
    await runDueSchedules(o.ctx);
    await o.worker.drain();
    const ps = await o.db.select().from(projects).where(eq(projects.objectiveId, objectiveId));
    expect(ps).toHaveLength(2);
    const second = ps.find((p) => p.title.includes('—'))!;
    const ts = await o.db.select().from(tasks).where(eq(tasks.projectId, second.id));
    expect(ts.map((t) => t.kind)).toEqual(['work']); // mode cepat: tanpa review
  });

  it('objective yang sudah selesai aktif lagi saat dijadwalkan', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    const { objectiveId } = await createObjective(o.ctx, { title: 'Sekali', mode: 'direct' });
    await o.worker.drain();
    expect((await o.db.select().from(objectives).where(eq(objectives.id, objectiveId)))[0]?.status).toBe('completed');
    await setSchedule(o.ctx, objectiveId, { kind: 'daily', timeOfDay: '07:30' });
    expect((await o.db.select().from(objectives).where(eq(objectives.id, objectiveId)))[0]?.status).toBe('active');
    await expect(setSchedule(o.ctx, objectiveId, { kind: 'daily', timeOfDay: '25:00' })).rejects.toThrow(/HH:MM/);
  });
});
