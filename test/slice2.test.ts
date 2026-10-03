import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agents, events, objectives, taskDependencies, tasks } from '../src/db/schema';
import { createObjective } from '../src/orchestrator/office';
import { officeView } from '../src/orchestrator/queries';
import type { FakeHandler } from '../src/runtimes/fake';
import type { RunRequest, RunResult } from '../src/runtimes/runtime';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function office(handler?: FakeHandler) {
  const o = await setupOffice(handler);
  cleanup = async () => {
    await o.worker.stop();
    await o.close();
  };
  return o;
}

type Kind = 'planning' | 'review' | 'research' | 'work';
const kindOf = (req: RunRequest): Kind => {
  const props = Object.keys((req.outputSchema as { properties?: object }).properties ?? {});
  return props.includes('tasks') ? 'planning' : props.includes('verdict') ? 'review' : props.includes('findings') ? 'research' : 'work';
};

/** Handler per jenis task; jenis yang tidak diatur memakai perilaku default FakeRuntime. */
function byKind(overrides: Partial<Record<Kind, (req: RunRequest, n: number) => Partial<RunResult> | undefined>>): FakeHandler {
  const counts: Record<string, number> = {};
  return async (req, call) => {
    const k = kindOf(req);
    counts[k] = (counts[k] ?? 0) + 1;
    const r = overrides[k]?.(req, counts[k]!);
    if (r) return r;
    const { FakeRuntime } = await import('../src/runtimes/fake');
    const fallback = new FakeRuntime();
    return fallback.run(req, new AbortController().signal);
  };
}

const tasksOf = (db: Awaited<ReturnType<typeof office>>['db'], objectiveId: string) =>
  db.select().from(tasks).where(eq(tasks.objectiveId, objectiveId)).orderBy(asc(tasks.createdAt));

/** Task yang dibuat dalam satu transaksi bisa punya created_at sama; bandingkan per plan key. */
const statusByKey = (all: { planKey: string | null; kind: string; status: string }[]) =>
  Object.fromEntries(all.map((t) => [t.planKey, `${t.kind}:${t.status}`]));

describe('Slice 2: Manager merencanakan → tim mengerjakan → Manager mereview', () => {
  it('menjalankan rencana sesuai dependency dan meneruskan hasil lewat context/', async () => {
    const { ctx, db, worker, runtime } = await office();
    const { objectiveId } = await createObjective(ctx, { title: 'Caption kopi lokal' });
    await worker.drain();

    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('completed');

    const all = await tasksOf(db, objectiveId);
    expect(statusByKey(all)).toEqual({
      plan: 'planning:completed',
      riset: 'research:completed',
      konten: 'work:completed',
      'review-1': 'review:completed',
    });
    // Urutan eksekusi mengikuti dependency.
    expect(runtime.calls.map(kindOf)).toEqual(['planning', 'research', 'work', 'review']);

    // Penulis menerima file riset di context/riset/.
    const writer = all.find((t) => t.planKey === 'konten')!;
    const writerCall = runtime.calls[2]!;
    expect(writerCall.prompt).toContain('context/riset/out/riset.md');
    expect(existsSync(path.join(writerCall.workDir, 'context/riset/out/riset.md'))).toBe(true);

    // Review bergantung pada semua task rencana.
    const review = all.find((t) => t.kind === 'review')!;
    const reviewDeps = await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, review.id));
    const riset = all.find((t) => t.planKey === 'riset')!;
    expect(reviewDeps.map((d) => d.dependsOn).sort()).toEqual([riset.id, writer.id].sort());
    expect(runtime.calls[3]!.prompt).toContain('context/konten/out/result.md');
  });

  it('rencana dengan dependency melingkar → repair → rencana valid dijalankan', async () => {
    const cyclic = {
      summary: 'x',
      tasks: [
        { key: 'aa', title: 'Tugas A', role: 'content_writer', instructions: 'Kerjakan bagian A.', depends_on: ['bb'] },
        { key: 'bb', title: 'Tugas B', role: 'content_writer', instructions: 'Kerjakan bagian B.', depends_on: ['aa'] },
      ],
      review_focus: 'x',
    };
    const { ctx, db, worker, runtime } = await office(byKind({ planning: (_r, n) => (n === 1 ? { output: cyclic } : undefined) }));
    const { objectiveId } = await createObjective(ctx, { title: 'Caption' });
    await worker.drain();

    expect(runtime.calls[1]?.prompt).toContain('dependency melingkar');
    expect(runtime.calls[1]?.resumeSessionId).toBeTruthy();
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('completed');
  });

  it('review meminta revisi → task revisi + review putaran 2 → selesai', async () => {
    const { ctx, db, worker, runtime } = await office(
      byKind({
        review: (_r, n) =>
          n === 1
            ? { output: { verdict: 'revise', feedback: 'Terlalu panjang.', revisions: [{ task_key: 'konten', instructions: 'Ringkas jadi 80 kata.' }] } }
            : undefined,
      }),
    );
    const { objectiveId } = await createObjective(ctx, { title: 'Caption' });
    await worker.drain();

    const all = await tasksOf(db, objectiveId);
    const versions = all.filter((t) => t.planKey === 'konten');
    expect(versions).toHaveLength(2);
    expect(versions[1]?.retryOfTaskId).toBe(versions[0]?.id);
    expect(versions[1]?.title).toContain('(revisi 1)');
    expect(all.filter((t) => t.kind === 'review').map((t) => t.planKey).sort()).toEqual(['review-1', 'review-2']);

    const revisionCall = runtime.calls.find((c) => c.prompt.includes('## Revisi dari Manager'));
    expect(revisionCall?.prompt).toContain('Ringkas jadi 80 kata.');
    expect(existsSync(path.join(revisionCall!.workDir, 'context/konten/out/result.md'))).toBe(true);

    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('completed');
  });

  it('revisi dibatasi 2 putaran, lalu diserahkan ke Owner', async () => {
    const { ctx, db, worker } = await office(
      byKind({ review: () => ({ output: { verdict: 'revise', feedback: 'Belum pas.', revisions: [{ task_key: 'konten', instructions: 'Coba lagi.' }] } }) }),
    );
    const { objectiveId } = await createObjective(ctx, { title: 'Caption' });
    await worker.drain();

    const all = await tasksOf(db, objectiveId);
    expect(all.filter((t) => t.kind === 'review')).toHaveLength(3);
    expect(all.filter((t) => t.planKey === 'konten')).toHaveLength(3);
    const escalated = await db.select().from(events).where(and(eq(events.objectiveId, objectiveId), eq(events.type, 'review.escalated')));
    expect(escalated).toHaveLength(1);
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('completed');
  });

  it('task riset gagal → task yang bergantung ikut dibatalkan → objective gagal', async () => {
    const { ctx, db, worker } = await office(byKind({ research: () => ({ status: 'error', error: 'web down' }) }));
    const { objectiveId } = await createObjective(ctx, { title: 'Caption' });
    await worker.drain();

    const all = await tasksOf(db, objectiveId);
    expect(statusByKey(all)).toEqual({
      plan: 'planning:completed',
      riset: 'research:failed',
      konten: 'work:cancelled',
      'review-1': 'review:cancelled',
    });
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('failed');
  });

  it('tanpa agent untuk role yang diminta, task menunggu dan Owner diberi tahu', async () => {
    const { ctx, db, worker, emitted } = await office();
    await db.update(agents).set({ status: 'inactive' }).where(eq(agents.roleId, 'researcher'));
    const { objectiveId } = await createObjective(ctx, { title: 'Caption' });
    await worker.drain();

    const all = await tasksOf(db, objectiveId);
    const riset = all.find((t) => t.planKey === 'riset')!;
    expect(riset.status).toBe('pending');
    expect(riset.error).toContain('researcher');
    expect(emitted.filter((e) => e.type === 'task.unassignable' && e.entityId === riset.id)).toHaveLength(1);
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('active');

    // Inbox hanya memuat task yang benar-benar tanpa agent, bukan task yang menunggu dependency.
    const view = await officeView(ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.inbox.map((i) => [i.kind, i.taskId])).toEqual([['task_unassignable', riset.id]]);
  });
});
