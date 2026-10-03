import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agents, approvals, departments, events, roles, tasks } from '../src/db/schema';
import { Gateway } from '../src/gateway/gateway';
import { allowedToolIds } from '../src/gateway/tools';
import { createObjective } from '../src/orchestrator/office';
import { applyOrgChange, listOrg, loadPlannableRoles } from '../src/orchestrator/org';
import { officeView } from '../src/orchestrator/queries';
import { setSetting } from '../src/orchestrator/settings';
import { reviewStaffing, type RuntimeLoad } from '../src/orchestrator/staffing';
import { FakeRuntime, type FakeHandler } from '../src/runtimes/fake';
import type { RunRequest } from '../src/runtimes/runtime';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function office(handler?: FakeHandler, opts?: { concurrency?: number }) {
  const o = await setupOffice(handler, opts);
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}

const propsOf = (req: RunRequest) => Object.keys((req.outputSchema as { properties?: object }).properties ?? {});
const roleStaff = (db: Awaited<ReturnType<typeof office>>['db'], roleId: string) => db.select().from(agents).where(eq(agents.roleId, roleId));
const freeLoad = (over: Partial<RuntimeLoad> = {}) => () => ({ inflight: 0, concurrency: 3, blocked: false, ...over });

/** Handler lambat yang mencatat berapa sesi aktif bersamaan. */
function tracker() {
  const state = { active: 0, max: 0 };
  const handler: FakeHandler = async (req) => {
    state.active++;
    state.max = Math.max(state.max, state.active);
    await new Promise((r) => setTimeout(r, 120));
    const out = await new FakeRuntime().run(req, new AbortController().signal);
    state.active--;
    return out;
  };
  return { state, handler };
}

describe('Satu karyawan, satu pekerjaan; paralel sesuai jumlah staf', () => {
  it('satu staf mengerjakan task bergantian walau slot runtime ada dua', async () => {
    const t = tracker();
    const o = await office(t.handler, { concurrency: 2 });
    await createObjective(o.ctx, { title: 'Satu', mode: 'direct' });
    await createObjective(o.ctx, { title: 'Dua', mode: 'direct' });
    await o.worker.drain();
    expect(t.state.max).toBe(1);
  });

  it('dua staf role yang sama mengerjakan dua task bersamaan; agent dipilih saat task diambil', async () => {
    const t = tracker();
    const o = await office(t.handler, { concurrency: 2 });
    const a = await createObjective(o.ctx, { title: 'Satu', mode: 'direct' });
    const b = await createObjective(o.ctx, { title: 'Dua', mode: 'direct' });
    // Kedua task sudah ditugaskan ke staf pertama; staf kedua baru direkrut sesudahnya.
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner');
    await o.worker.drain();

    expect(t.state.max).toBe(2);
    const done = await o.db.select().from(tasks).where(and(eq(tasks.kind, 'work')));
    expect(done.map((x) => x.status)).toEqual(['completed', 'completed']);
    expect(new Set(done.map((x) => x.assignedAgentId)).size).toBe(2);
    expect([a.taskId, b.taskId].sort()).toEqual(done.map((x) => x.id).sort());
  });

  it('rate limit menurunkan batas paralel separuh; run berhasil menaikkannya lagi', async () => {
    let call = 0;
    const o = await office(async (req) => {
      call++;
      return call === 1 ? { status: 'rate_limited', error: 'limit', retryAt: new Date(Date.now() + 1000) } : new FakeRuntime().run(req, new AbortController().signal);
    }, { concurrency: 4 });
    await createObjective(o.ctx, { title: 'Limit', mode: 'direct' });
    await o.worker.tick();
    await o.worker.drain();
    expect(o.worker.runtimeState('fake').concurrency).toBe(2); // 4 → 2
    expect(o.worker.runtimeState('fake').cooldownUntil).not.toBeNull();
  });
});

describe('Aturan HRD menambah staf', () => {
  /** Staf pertama sibuk (running) dan ada task siap kerja yang sudah lama menunggu. */
  async function backlog(o: Awaited<ReturnType<typeof office>>) {
    // Karyawan awal dianggap sudah lama bekerja (jeda 10 menit antar rekrutan tidak berlaku).
    await o.db.update(agents).set({ createdAt: new Date(Date.now() - 3600_000) });
    const first = await createObjective(o.ctx, { title: 'Sedang jalan', mode: 'direct' });
    const second = await createObjective(o.ctx, { title: 'Menunggu', mode: 'direct' });
    const [writer] = await roleStaff(o.db, 'content_writer');
    await o.db.update(tasks).set({ status: 'running', assignedAgentId: writer!.id }).where(eq(tasks.id, first.taskId));
    await o.db.update(tasks).set({ queuedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(tasks.id, second.taskId));
    return { writer: writer!, waiting: second.taskId };
  }

  it('rekrut otomatis di bawah batas, satu kali per jeda', async () => {
    const o = await office();
    await backlog(o);
    await reviewStaffing(o.ctx, freeLoad());
    const staff = await roleStaff(o.db, 'content_writer');
    expect(staff).toHaveLength(2);
    expect(staff.find((a) => a.name === 'Content Writer 2')).toMatchObject({ createdBy: 'hrd:auto', status: 'active', roleId: 'content_writer' });
    expect(o.emitted.some((e) => e.type === 'agent.created' && (e.payload as any).reason?.includes('Antrean'))).toBe(true);

    await reviewStaffing(o.ctx, freeLoad()); // dalam jeda 10 menit: tidak menambah lagi
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(2);
  });

  it('tidak merekrut bila masih ada staf menganggur atau task belum menunggu cukup lama', async () => {
    const o = await office();
    await createObjective(o.ctx, { title: 'Baru masuk', mode: 'direct' });
    await reviewStaffing(o.ctx, freeLoad());
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(1);
    const { writer } = await backlog(o);
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner'); // staf kedua menganggur
    await reviewStaffing(o.ctx, freeLoad());
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(2);
    expect(writer.id).toBeTruthy();
  });

  it('slot runtime penuh: staf tambahan tidak membantu, jadi tidak merekrut dan hanya mencatat', async () => {
    const o = await office();
    await backlog(o);
    await reviewStaffing(o.ctx, freeLoad({ inflight: 3, concurrency: 3 }));
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(1);
    expect(o.emitted.filter((e) => e.type === 'staffing.capacity_limited')).toHaveLength(1);
    await reviewStaffing(o.ctx, freeLoad({ inflight: 3, concurrency: 3 }));
    expect(o.emitted.filter((e) => e.type === 'staffing.capacity_limited')).toHaveLength(1); // tidak membanjiri
  });

  it('runtime sedang kena limit atau kuota habis: tidak merekrut', async () => {
    const o = await office();
    await backlog(o);
    await reviewStaffing(o.ctx, freeLoad({ blocked: true }));
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(1);
  });

  it('di atas batas: minta persetujuan Owner (satu permintaan), disetujui → staf bertambah', async () => {
    const o = await office();
    o.ctx.gateway = new Gateway(o.ctx, 'http://x');
    await setSetting(o.db, 'max_staff_per_role', 1);
    await backlog(o);
    await reviewStaffing(o.ctx, freeLoad());
    await reviewStaffing(o.ctx, freeLoad());
    const pending = await o.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolId).toBe('propose_org_change');
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(1);

    const view = await officeView(o.ctx, () => ({ inflight: 0, cooldownUntil: null }));
    const item = view.inbox.find((i) => i.kind === 'approval_pending')!;
    expect(item.title).toContain('diminta sistem');
    expect(item.detail).toContain('Rekrut 1 staf content_writer');

    const r = await o.ctx.gateway.approve(pending[0]!.id);
    expect(r.ok).toBe(true);
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(2);
  });

  it('mode "ask": selalu minta persetujuan walau di bawah batas', async () => {
    const o = await office();
    o.ctx.gateway = new Gateway(o.ctx, 'http://x');
    await setSetting(o.db, 'auto_hire', 'ask');
    await backlog(o);
    await reviewStaffing(o.ctx, freeLoad());
    expect(await roleStaff(o.db, 'content_writer')).toHaveLength(1);
    expect(await o.db.select().from(approvals).where(eq(approvals.status, 'pending'))).toHaveLength(1);
  });
});

describe('Organisasi dinamis: divisi dan role baru lewat usulan HRD', () => {
  const hrdCaller = async (db: Awaited<ReturnType<typeof office>>['db']) => {
    const [a] = await roleStaff(db, 'hrd');
    return { agentId: a!.id, agentName: a!.name, roleId: 'hrd', taskId: 't', sessionId: 's', objectiveId: '00000000-0000-0000-0000-000000000000' };
  };

  it('divisi bawaan ter-seed dan terhubung ke role', async () => {
    const o = await office();
    const org = await listOrg(o.ctx);
    expect(org.departments.map((d) => d.id)).toEqual(['executive', 'rnd', 'operations', 'content']);
    expect(org.departments.find((d) => d.id === 'content')!.roles.map((r) => [r.id, r.staff])).toEqual([['content_writer', 1]]);
    expect(org.limits).toEqual({ maxStaffPerRole: 3, autoHire: 'auto', hireWaitSeconds: 90, suspendIdleMinutes: 30 });
  });

  it('hanya HRD yang punya tool usulan organisasi', async () => {
    expect(allowedToolIds('hrd')).toContain('propose_org_change');
    for (const r of ['ceo', 'manager', 'content_writer', 'researcher']) expect(allowedToolIds(r)).not.toContain('propose_org_change');
    expect(allowedToolIds('role_buatan_baru')).toEqual(['knowledge_search', 'notify_owner']);
  });

  it('HRD mengusulkan divisi + role + staf: menunggu Owner, lalu diterapkan sistem', async () => {
    const o = await office();
    const gw = new Gateway(o.ctx, 'http://x');
    o.ctx.gateway = gw;
    const caller = await hrdCaller(o.db);

    const r1 = await gw.call(caller, 'propose_org_change', { type: 'new_department', name: 'Desain Visual', reason: 'Konten butuh gambar' });
    expect(r1.message).toContain('persetujuan Owner');
    expect((await o.db.select().from(departments)).map((d) => d.id)).not.toContain('desain-visual');
    const [p1] = await o.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    expect((await gw.approve(p1!.id)).ok).toBe(true);
    const [dept] = await o.db.select().from(departments).where(eq(departments.id, 'desain-visual'));
    expect(dept).toMatchObject({ name: 'Desain Visual', createdBy: 'hrd-proposal' });
    expect(dept?.color).toMatch(/^#[0-9a-f]{6}$/i);

    await gw.call(caller, 'propose_org_change', {
      type: 'new_role', name: 'Visual Designer', department_id: 'desain-visual', native_tools: 'workspace_write', task_kind: 'work',
      description: 'membuat brief dan aset visual', instructions: 'Kamu desainer visual. Buat brief visual yang jelas untuk konten media sosial.', reason: 'Gambar belum ada yang mengerjakan',
    });
    const [p2] = await o.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    expect((await gw.approve(p2!.id)).ok).toBe(true);

    const [role] = await o.db.select().from(roles).where(eq(roles.id, 'visual_designer'));
    expect(role).toMatchObject({ department: 'desain-visual', plannable: true, taskKind: 'work' });
    const staff = await roleStaff(o.db, 'visual_designer');
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ name: 'Visual Designer', status: 'active' });
    expect(allowedToolIds('visual_designer')).not.toContain('instagram_publish');
    expect((await loadPlannableRoles(o.db)).map((x) => x.id)).toContain('visual_designer');
    expect(o.emitted.map((e) => e.type)).toEqual(expect.arrayContaining(['department.created', 'role.created', 'agent.created']));
  });

  it('Manager bisa memakai role baru dalam rencana; role yang tidak ada ditolak lalu diperbaiki', async () => {
    let planned = 0;
    const o = await office(async (req) => {
      if (propsOf(req).includes('tasks')) {
        planned++;
        const role = planned === 1 ? 'role_tidak_ada' : 'visual_designer';
        return { output: { summary: 'Rencana', tasks: [{ key: 'visual', title: 'Brief visual', role, instructions: 'Buat brief visual untuk konten kopi.', depends_on: [] }], review_focus: 'Brief jelas' } };
      }
      return new FakeRuntime().run(req, new AbortController().signal);
    });
    await applyOrgChange(o.ctx, { type: 'new_department', name: 'Desain Visual', reason: 'uji' }, 'owner');
    await applyOrgChange(o.ctx, { type: 'new_role', name: 'Visual Designer', department_id: 'desain-visual', task_kind: 'work', description: 'membuat brief visual', native_tools: 'workspace_write', instructions: 'Kamu desainer visual untuk konten media sosial.', reason: 'uji' }, 'owner');
    const { objectiveId } = await createObjective(o.ctx, { title: 'Visual kopi', mode: 'planned' });
    await o.worker.drain();

    const repair = o.runtime.calls.find((c) => c.prompt.includes('tidak tersedia'));
    expect(repair?.prompt).toContain('visual_designer'); // daftar role dinamis ikut di pesan perbaikan
    const all = await o.db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId));
    const visual = all.find((t) => t.planKey === 'visual')!;
    expect(visual.status).toBe('completed');
    const [designer] = await roleStaff(o.db, 'visual_designer');
    expect(visual.assignedAgentId).toBe(designer!.id);
    const planCall = o.runtime.calls.find((c) => propsOf(c).includes('tasks'))!;
    expect(planCall.prompt).toContain('- visual_designer: membuat brief visual');
  });

  it('validasi perubahan: divisi tidak ada, instruksi terlalu pendek, role duplikat id dibuat unik', async () => {
    const o = await office();
    await expect(applyOrgChange(o.ctx, { type: 'new_role', name: 'Analis', department_id: 'tidak-ada', instructions: 'x'.repeat(30), reason: 'uji' }, 'owner')).rejects.toThrow(/tidak ada/);
    await expect(applyOrgChange(o.ctx, { type: 'new_role', name: 'Analis', department_id: 'rnd', instructions: 'pendek', reason: 'uji' }, 'owner')).rejects.toThrow(/minimal 20/);
    await applyOrgChange(o.ctx, { type: 'new_department', name: 'Lab R&D', reason: 'uji' }, 'owner');
    const ids = (await o.db.select().from(departments)).map((d) => d.id);
    expect(ids).toContain('lab-r-d');
    await applyOrgChange(o.ctx, { type: 'new_department', name: 'Lab R&D', reason: 'uji' }, 'owner');
    expect((await o.db.select().from(departments)).map((d) => d.id)).toContain('lab-r-d-2');
  });

  it('kepala divisi = karyawan aktif tertua; kantor memuat daftar divisi', async () => {
    const o = await office();
    await applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', reason: 'uji' }, 'owner');
    const view = await officeView(o.ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.departments.map((d) => d.id)).toEqual(['executive', 'rnd', 'operations', 'content']);
    const content = view.agents.filter((a) => a.department === 'content');
    expect(content.map((a) => [a.name, a.isHead])).toEqual(expect.arrayContaining([['Content Writer', true], ['Content Writer 2', false]]));
    expect(view.agents.find((a) => a.roleId === 'ceo')!.isHead).toBe(true);
    // Market Researcher menunggu provider: yang memimpin R&D adalah Research Agent yang aktif.
    expect(view.agents.filter((a) => a.department === 'rnd').map((a) => [a.name, a.isHead])).toEqual(expect.arrayContaining([['Research Agent', true], ['Market Researcher', false]]));
    void events;
  });
});
