import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agents, events, objectives, tasks } from '../src/db/schema';
import { createObjective } from '../src/orchestrator/office';
import { applyOrgChange } from '../src/orchestrator/org';
import { officeView } from '../src/orchestrator/queries';
import { setSetting } from '../src/orchestrator/settings';
import { reviewStaffing, type RuntimeLoad } from '../src/orchestrator/staffing';
import { agentPerformance, changeAgentLifecycle, reviewDownsizing } from '../src/orchestrator/workforce';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
async function office() {
  const o = await setupOffice();
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}
const staff = (o: Awaited<ReturnType<typeof office>>, roleId: string) => o.db.select().from(agents).where(eq(agents.roleId, roleId));
const freeLoad = (): (() => RuntimeLoad) => () => ({ inflight: 0, concurrency: 3, blocked: false });
const ago = (min: number) => new Date(Date.now() - min * 60_000);

describe('Siklus hidup agent', () => {
  it('rumahkan → aktifkan kembali → pensiun; pensiun hilang dari kantor; riwayat tetap', async () => {
    const o = await office();
    const [a] = await staff(o, 'content_writer');
    await changeAgentLifecycle(o.ctx, a!.id, 'suspend', 'owner', 'uji');
    expect((await staff(o, 'content_writer'))[0]!.status).toBe('inactive');
    await expect(changeAgentLifecycle(o.ctx, a!.id, 'suspend', 'owner', 'uji')).rejects.toThrow(/sudah dirumahkan/);
    await changeAgentLifecycle(o.ctx, a!.id, 'reactivate', 'owner', 'uji');
    expect((await staff(o, 'content_writer'))[0]!.status).toBe('active');

    await changeAgentLifecycle(o.ctx, a!.id, 'retire', 'owner', 'uji');
    const view = await officeView(o.ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.agents.find((x) => x.id === a!.id)).toBeUndefined();
    expect((await staff(o, 'content_writer'))).toHaveLength(1); // baris tetap ada (arsip)
    const types = (await o.db.select().from(events)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['agent.suspended', 'agent.reactivated', 'agent.retired']));
  });

  it('merekrut memakai ulang staf yang dirumahkan lebih dulu', async () => {
    const o = await office();
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner');
    const [first, second] = await staff(o, 'content_writer');
    await changeAgentLifecycle(o.ctx, second!.id, 'suspend', 'owner', 'uji');
    const res = (await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'ramai lagi' }, 'owner')) as unknown as { id: string; reused: boolean };
    expect(res.reused).toBe(true);
    expect(res.id).toBe(second!.id);
    expect(await staff(o, 'content_writer')).toHaveLength(2);
    expect(first!.id).not.toBe(second!.id);
  });
});

describe('HRD menurunkan staf', () => {
  it('staf tambahan yang menganggur dirumahkan, staf tertua tetap; ada antrean → tidak', async () => {
    const o = await office();
    await o.db.update(agents).set({ createdAt: ago(600) });
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner');
    await o.db.update(agents).set({ createdAt: ago(120) }).where(eq(agents.name, 'Content Writer 2'));

    await reviewDownsizing(o.ctx);
    const after = await staff(o, 'content_writer');
    expect(after.find((a) => a.name === 'Content Writer')!.status).toBe('active');
    expect(after.find((a) => a.name === 'Content Writer 2')!.status).toBe('inactive');
    // Role lain yang hanya punya satu staf tidak disentuh.
    expect((await staff(o, 'manager'))[0]!.status).toBe('active');
  });

  it('mematuhi suspend_idle_minutes dan nilai 0 mematikan aturan', async () => {
    const o = await office();
    await o.db.update(agents).set({ createdAt: ago(600) });
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner');
    await o.db.update(agents).set({ createdAt: ago(5) }).where(eq(agents.name, 'Content Writer 2'));
    await reviewDownsizing(o.ctx); // baru 5 menit, ambang 30
    expect((await staff(o, 'content_writer')).every((a) => a.status === 'active')).toBe(true);
    await o.db.update(agents).set({ createdAt: ago(120) }).where(eq(agents.name, 'Content Writer 2'));
    await setSetting(o.db, 'suspend_idle_minutes', 0);
    await reviewDownsizing(o.ctx);
    expect((await staff(o, 'content_writer')).every((a) => a.status === 'active')).toBe(true);
  });

  it('agent on-demand dirumahkan saat menganggur dan dibangunkan saat ada antrean', async () => {
    const o = await office();
    await o.db.update(agents).set({ createdAt: ago(600) });
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji', tenure: 'on_demand' }, 'owner');
    await o.db.update(agents).set({ createdAt: ago(600) });
    await o.db.update(agents).set({ status: 'inactive' }).where(eq(agents.name, 'Content Writer'));
    await reviewDownsizing(o.ctx);
    expect((await staff(o, 'content_writer')).every((a) => a.status === 'inactive')).toBe(true);

    // Task siap kerja untuk role yang semua stafnya dirumahkan → satu dibangunkan segera.
    const { objectiveId } = await createObjective(o.ctx, { title: 'Tulis caption', mode: 'direct' });
    await o.db.update(tasks).set({ status: 'queued', requiredRoleId: 'content_writer' }).where(eq(tasks.objectiveId, objectiveId));
    await reviewStaffing(o.ctx, freeLoad());
    expect((await staff(o, 'content_writer')).filter((a) => a.status === 'active')).toHaveLength(1);
  });

  it('agent temporary dirumahkan saat objective-nya selesai', async () => {
    const o = await office();
    const { objectiveId } = await createObjective(o.ctx, { title: 'Peluncuran' });
    await o.worker.drain();
    await o.db.update(agents).set({ createdAt: ago(600) });
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'researcher', reason: 'proyek peluncuran', tenure: 'temporary', objective_id: objectiveId }, 'owner');
    const temp = (await staff(o, 'researcher')).find((a) => a.tenure === 'temporary')!;
    expect(temp.tempObjectiveId).toBe(objectiveId);
    const [obj] = await o.db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj!.status).toBe('completed');
    await reviewDownsizing(o.ctx);
    expect((await o.db.select().from(agents).where(eq(agents.id, temp.id)))[0]!.status).toBe('inactive');
  });
});

describe('Performa agent', () => {
  it('menghitung task, token, dan utilisasi per agent', async () => {
    const o = await office();
    await createObjective(o.ctx, { title: 'Caption kopi' });
    await o.worker.drain();
    const perf = await agentPerformance(o.ctx);
    const writer = perf.agents.find((a) => a.roleId === 'content_writer')!;
    expect(writer.tasksDone).toBeGreaterThan(0);
    expect(writer.tasksFailed).toBe(0);
    expect(writer.utilization).toBeGreaterThanOrEqual(0);
    expect(perf.agents.length).toBeGreaterThan(5);
  });
});
