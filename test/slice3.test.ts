import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agents, decisions, objectives, projects, tasks } from '../src/db/schema';
import { createObjective } from '../src/orchestrator/office';
import { officeView } from '../src/orchestrator/queries';
import { setSetting } from '../src/orchestrator/settings';
import { approveDecision, rejectDecision, reviseDecision } from '../src/orchestrator/strategy';
import { FakeRuntime, type FakeHandler } from '../src/runtimes/fake';
import type { RunRequest, RunResult } from '../src/runtimes/runtime';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function office(handler?: FakeHandler) {
  const o = await setupOffice(handler);
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}

const propsOf = (req: RunRequest) => Object.keys((req.outputSchema as { properties?: object }).properties ?? {});
const isDecision = (req: RunRequest) => propsOf(req).includes('execution_brief');

/** Perilaku default FakeRuntime, kecuali untuk task keputusan CEO. */
function decisionAs(make: (n: number) => Record<string, unknown>): FakeHandler {
  let n = 0;
  return async (req) => {
    if (isDecision(req)) {
      n++;
      return { output: make(n) } as Partial<RunResult>;
    }
    return new FakeRuntime().run(req, new AbortController().signal);
  };
}

const baseDecision = {
  strategy: 'Strategi uji',
  success_metrics: ['1 konten/hari'],
  budget_cap_usd: 3,
  team: [],
  owner_requests: [],
  execution_brief: 'Langsung tulis konten.',
};

async function objectiveOf(db: any, id: string) {
  const [o] = await db.select().from(objectives).where(eq(objectives.id, id));
  return o as typeof objectives.$inferSelect;
}

describe('Slice 3: strategic loop CEO → eksekutif → keputusan → Owner → Manager', () => {
  it('konsultasi selektif, R&D lebih dulu, keputusan menunggu Owner, lalu dieksekusi', async () => {
    const { ctx, db, worker, runtime } = await office();
    const { objectiveId } = await createObjective(ctx, { title: 'Bangun Instagram kopi lokal', mode: 'strategic' });
    expect((await objectiveOf(db, objectiveId)).status).toBe('strategizing');
    await worker.drain();

    // CEO hanya bertanya ke R&D dan CFO (bukan semua eksekutif).
    const strategic = await db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId));
    expect(strategic.map((t) => t.planKey).sort()).toEqual(['consult-cfo', 'consult-researcher', 'decision-1', 'framing']);
    const kinds = runtime.calls.map((c) => propsOf(c));
    expect(kinds[1]).toContain('findings'); // R&D sebelum CFO
    expect(kinds[2]).toContain('recommendation');

    // Keputusan menerima visi CEO dan hasil konsultasi lewat prompt.
    const decisionCall = runtime.calls.find(isDecision)!;
    expect(decisionCall.prompt).toContain('Visi:');
    expect(decisionCall.prompt).toContain('Rekomendasi: Mulai kecil.');

    const obj = await objectiveOf(db, objectiveId);
    expect(obj.status).toBe('awaiting_approval');
    const [d] = await db.select().from(decisions).where(eq(decisions.objectiveId, objectiveId));
    expect(d?.status).toBe('proposed');
    const view = await officeView(ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.inbox.map((i) => i.kind)).toContain('decision_pending');

    await approveDecision(ctx, d!.id, 'Lanjut');
    await worker.drain();

    const done = await objectiveOf(db, objectiveId);
    expect(done.status).toBe('completed');
    expect(done.budgetUsdMicros).toBe(5_000_000);
    const [proj] = await db.select().from(projects).where(eq(projects.objectiveId, objectiveId));
    expect(proj?.decisionId).toBe(d!.id);
    const planning = runtime.calls.find((c) => propsOf(c).includes('tasks'))!;
    expect(planning.prompt).toContain('Keputusan CEO yang sudah disetujui Owner');
  });

  it('Owner minta revisi → CEO membuat usulan baru dengan catatan Owner → Owner menolak', async () => {
    const { ctx, db, worker, runtime } = await office(decisionAs((n) => ({ ...baseDecision, strategy: `Strategi versi ${n}` })));
    const { objectiveId } = await createObjective(ctx, { title: 'Objective revisi', mode: 'strategic' });
    await worker.drain();
    const [first] = await db.select().from(decisions).where(eq(decisions.objectiveId, objectiveId));

    await reviseDecision(ctx, first!.id, 'Fokus ke video pendek.');
    expect((await objectiveOf(db, objectiveId)).status).toBe('strategizing');
    await worker.drain();

    const all = await db.select().from(decisions).where(eq(decisions.objectiveId, objectiveId));
    expect(all.map((x) => x.status).sort()).toEqual(['proposed', 'rejected']);
    const revisionCall = runtime.calls.filter(isDecision)[1]!;
    expect(revisionCall.prompt).toContain('Fokus ke video pendek.');
    expect(revisionCall.prompt).toContain('Rekomendasi:'); // konsultasi yang sama dipakai ulang
    const consultCount = runtime.calls.filter((c) => propsOf(c).includes('recommendation')).length;
    expect(consultCount).toBe(1); // tidak menjalankan ulang konsultasi

    const second = all.find((x) => x.status === 'proposed')!;
    expect((second.content as { strategy: string }).strategy).toBe('Strategi versi 2');
    await rejectDecision(ctx, second.id, 'Tidak jadi');
    expect((await objectiveOf(db, objectiveId)).status).toBe('cancelled');
    await expect(approveDecision(ctx, second.id)).rejects.toThrow(/sudah berstatus rejected/);
  });

  it('mode otomatis: keputusan tanpa permintaan khusus langsung dijalankan', async () => {
    const { ctx, db, worker } = await office(decisionAs(() => baseDecision));
    await setSetting(db, 'decision_approval', 'auto');
    const { objectiveId } = await createObjective(ctx, { title: 'Auto', mode: 'strategic' });
    await worker.drain();
    const [d] = await db.select().from(decisions).where(eq(decisions.objectiveId, objectiveId));
    expect(d?.status).toBe('approved');
    expect((await objectiveOf(db, objectiveId)).status).toBe('completed');
  });

  it('mode otomatis tetap menunggu Owner bila CEO meminta provider/budget/tool', async () => {
    const { ctx, db, worker } = await office(
      decisionAs(() => ({ ...baseDecision, owner_requests: [{ type: 'provider', key: 'openrouter', reason: 'Hemat kuota' }] })),
    );
    await setSetting(db, 'decision_approval', 'auto');
    const { objectiveId } = await createObjective(ctx, { title: 'Butuh provider', mode: 'strategic' });
    await worker.drain();
    expect((await objectiveOf(db, objectiveId)).status).toBe('awaiting_approval');
  });

  it('persetujuan menerapkan tim: role tanpa agent aktif → staf dirumahkan dipakai kembali (bukan agent baru)', async () => {
    const { ctx, db, worker } = await office(
      decisionAs(() => ({ ...baseDecision, team: [{ role: 'content_writer', runtime: 'claude-cli', reason: 'Butuh penulis' }] })),
    );
    await db.update(agents).set({ status: 'inactive' }).where(eq(agents.roleId, 'content_writer'));
    const { objectiveId } = await createObjective(ctx, { title: 'Tim baru', mode: 'strategic' });
    await worker.drain();
    const [d] = await db.select().from(decisions).where(eq(decisions.objectiveId, objectiveId));
    await approveDecision(ctx, d!.id);

    const writers = await db.select().from(agents).where(and(eq(agents.roleId, 'content_writer'), eq(agents.status, 'active')));
    expect(writers).toHaveLength(1);
    // Staf yang dirumahkan dipakai ulang lebih dulu, bukan membuat baris baru.
    expect(writers[0]).toMatchObject({ name: 'Content Writer' });
    expect(await db.select().from(agents).where(eq(agents.roleId, 'content_writer'))).toHaveLength(1);
  });

  it('kerangka CEO gagal → objective gagal', async () => {
    const { ctx, db, worker } = await office(async (req) =>
      propsOf(req).includes('questions') ? { status: 'error', error: 'crash' } : new FakeRuntime().run(req, new AbortController().signal),
    );
    const { objectiveId } = await createObjective(ctx, { title: 'Gagal', mode: 'strategic' });
    await worker.drain();
    expect((await objectiveOf(db, objectiveId)).status).toBe('failed');
  });
});
