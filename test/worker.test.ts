import { existsSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agentSessions, artifacts, objectives, projects, tasks } from '../src/db/schema';
import { createObjective } from '../src/orchestrator/office';
import { objectiveTrace } from '../src/orchestrator/queries';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function office(...args: Parameters<typeof setupOffice>) {
  const o = await setupOffice(...args);
  cleanup = async () => {
    await o.worker.stop();
    await o.close();
  };
  return o;
}

const validOutput = { summary: 'ok', artifacts: [{ path: 'out/result.md', description: 'hasil' }] };

describe('Mode cepat (Slice 1): objective → task → runtime → hasil tercatat', () => {
  it('menyelesaikan objective, menyimpan artifact, sesi, dan event', async () => {
    const { ctx, db, worker, runtime } = await office();
    const { objectiveId, taskId } = await createObjective(ctx, { title: 'Caption kopi lokal', description: 'Tulis satu caption.', mode: 'direct' });

    const [queued] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(queued?.status).toBe('queued');
    expect(queued?.assignedAgentId).toBeTruthy();

    await worker.drain();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('completed');
    expect(task?.result).toMatchObject({ summary: expect.any(String) });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.nativeTools).toBe('workspace_write');

    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('completed');
    const [proj] = await db.select().from(projects).where(eq(projects.objectiveId, objectiveId));
    expect(proj?.status).toBe('completed');

    const arts = await db.select().from(artifacts).where(eq(artifacts.taskId, taskId));
    expect(arts.map((a) => path.basename(a.path))).toEqual(['result.md']);
    expect(existsSync(path.join(ctx.workspacesDir, arts[0]!.path))).toBe(true);

    const trace = await objectiveTrace(ctx, objectiveId);
    expect(trace?.tasks[0]?.sessions).toHaveLength(1);
    expect(trace?.tasks[0]?.sessions[0]?.status).toBe('ok');
    const types = trace!.events.map((e) => e.type).reverse();
    expect(types).toEqual(
      expect.arrayContaining(['objective.created', 'task.assigned', 'task.started', 'session.started', 'session.ended', 'artifact.created', 'task.completed', 'objective.completed']),
    );
    expect(types.indexOf('task.started')).toBeLessThan(types.indexOf('task.completed'));
  });

  it('output tidak valid → satu repair dengan resume → selesai', async () => {
    const { ctx, db, worker, runtime } = await office((req, call) =>
      call === 1 ? { output: { wrong: true }, externalSessionId: 'ext-1' } : { output: validOutput },
    );
    const { taskId } = await createObjective(ctx, { title: 'Caption', mode: 'direct' });
    await worker.drain();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('completed');
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]?.resumeSessionId).toBe('ext-1');
    const sessions = await db.select().from(agentSessions).where(eq(agentSessions.taskId, taskId));
    expect(sessions.map((s) => [s.purpose, s.status]).sort()).toEqual([
      ['repair', 'ok'],
      ['run', 'invalid_output'],
    ]);
  });

  it('error berulang → retry sampai max_attempts → failed, objective failed', async () => {
    const { ctx, db, worker, runtime } = await office(() => ({ status: 'error', error: 'crash' }));
    const { objectiveId, taskId } = await createObjective(ctx, { title: 'Caption', mode: 'direct' });
    await worker.drain();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('failed');
    expect(task?.attempt).toBe(2);
    expect(task?.error).toBe('crash');
    expect(runtime.calls).toHaveLength(2);
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('failed');
  });

  it('rate limit → task ditunda tanpa menambah attempt', async () => {
    const until = new Date(Date.now() + 3600_000);
    const { ctx, db, worker } = await office(() => ({ status: 'rate_limited', error: 'usage limit', retryAt: until }));
    const { taskId } = await createObjective(ctx, { title: 'Caption', mode: 'direct' });
    await worker.drain();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('queued');
    expect(task?.attempt).toBe(0);
    expect(task?.notBefore?.getTime()).toBe(until.getTime());
    expect(worker.runtimeState('fake').cooldownUntil?.getTime()).toBe(until.getTime());
  });

  it('quota guard: tidak meng-claim task saat kuota jendela habis', async () => {
    const { ctx, db, worker, runtime, emitted } = await office(undefined, { maxRunsPerWindow: 1 });
    const a = await createObjective(ctx, { title: 'Satu', mode: 'direct' });
    const b = await createObjective(ctx, { title: 'Dua', mode: 'direct' });
    await worker.drain();

    const [ta] = await db.select().from(tasks).where(eq(tasks.id, a.taskId));
    const [tb] = await db.select().from(tasks).where(eq(tasks.id, b.taskId));
    expect(ta?.status).toBe('completed');
    expect(tb?.status).toBe('queued');
    expect(runtime.calls).toHaveLength(1);
    expect(emitted.some((e) => e.type === 'runtime.quota_reached')).toBe(true);
  });

  it('task running yatim (crash) dikembalikan ke antrean saat startup', async () => {
    const { ctx, db, worker } = await office();
    const { taskId } = await createObjective(ctx, { title: 'Caption', mode: 'direct' });
    await db.update(tasks).set({ status: 'running', attempt: 1, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(tasks.id, taskId));

    await worker.recoverOrphans(true);
    const [afterReclaim] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(afterReclaim?.status).toBe('queued');

    await worker.drain();
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('completed');
    expect(task?.attempt).toBe(2);
  });

  it('owner bisa membatalkan task di antrean', async () => {
    const { ctx, db, worker } = await office();
    const { objectiveId, taskId } = await createObjective(ctx, { title: 'Caption', mode: 'direct' });
    expect(await worker.cancel(taskId)).toBe(true);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.status).toBe('cancelled');
    const [obj] = await db.select().from(objectives).where(eq(objectives.id, objectiveId));
    expect(obj?.status).toBe('cancelled');
  });
});
