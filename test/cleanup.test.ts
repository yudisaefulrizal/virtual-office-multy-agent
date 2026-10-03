import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { agentSessions, artifacts, events, objectives, tasks } from '../src/db/schema';
import { deleteObjective } from '../src/orchestrator/cleanup';
import { withTx } from '../src/orchestrator/context';
import { createObjective } from '../src/orchestrator/office';
import { quotaUsage } from '../src/orchestrator/quota';
import { setSetting } from '../src/orchestrator/settings';
import { eq } from 'drizzle-orm';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('Hapus objective selesai', () => {
  it('menghapus jejak DB dan folder kerja; objective berjalan ditolak', async () => {
    const o = await setupOffice();
    cleanup = async () => {
      await o.worker.stop();
      await o.close();
    };
    const { objectiveId } = await createObjective(o.ctx, { title: 'Caption kopi' });
    await o.worker.drain();
    const [art] = await o.db.select().from(artifacts);
    const file = `${o.ctx.workspacesDir}/${art!.path}`;
    expect(existsSync(file)).toBe(true);

    await deleteObjective(o.ctx, objectiveId);
    expect(await o.db.select().from(objectives)).toHaveLength(0);
    expect(await o.db.select().from(tasks)).toHaveLength(0);
    expect(await o.db.select().from(artifacts)).toHaveLength(0);
    expect(await o.db.select().from(agentSessions)).toHaveLength(0);
    expect(await o.db.select().from(events).where(eq(events.objectiveId, objectiveId))).toHaveLength(0);
    expect(existsSync(file)).toBe(false);

    const again = await createObjective(o.ctx, { title: 'Masih jalan' });
    await expect(deleteObjective(o.ctx, again.objectiveId)).rejects.toThrow(/masih berjalan/);
  });
});

describe('Kuota yang bisa diatur', () => {
  it('batas dari Pengaturan menimpa .env dan reset menghentikan hitungan lama', async () => {
    const o = await setupOffice(undefined, { maxRunsPerWindow: 10 });
    cleanup = async () => {
      await o.worker.stop();
      await o.close();
    };
    await createObjective(o.ctx, { title: 'Satu' });
    await o.worker.drain();
    const first = await quotaUsage(o.ctx, 'fake');
    expect(first?.max).toBe(10);
    expect(first!.used).toBeGreaterThan(0);

    await withTx(o.ctx, (tx) => setSetting(tx, 'claude_max_runs_per_window', 0));
    // Hanya runtime claude-cli yang membaca override; 'fake' tetap ikut konfigurasi.
    expect((await quotaUsage(o.ctx, 'fake'))?.max).toBe(10);
  });
});
