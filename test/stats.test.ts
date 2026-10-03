import { afterEach, describe, expect, it } from 'vitest';
import { createObjective } from '../src/orchestrator/office';
import { usageStats } from '../src/orchestrator/stats';
import { FakeRuntime } from '../src/runtimes/fake';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('usageStats', () => {
  it('merangkum sesi per hari, agent, objective, dan runtime; biaya nyata terpisah dari estimasi', async () => {
    const o = await setupOffice(async (req) => ({
      ...(await new FakeRuntime().run(req, new AbortController().signal)),
      usage: { inputTokens: 100, outputTokens: 10, costUsdMicros: 1_500_000 },
    }));
    cleanup = async () => (await o.worker.stop(), await o.close());
    await createObjective(o.ctx, { title: 'Statistik', mode: 'planned' });
    await o.worker.drain();

    const s = await usageStats(o.ctx, 7);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.at(-1)!.sessions).toBe(4);
    expect(s.today).toMatchObject({ sessions: 4, inputTokens: 400, outputTokens: 40, actualUsdMicros: 6_000_000, estimateUsdMicros: 0 });
    expect(s.today.tasks.completed).toBe(4);
    expect(s.month.sessions).toBe(4);
    expect(s.byAgent.map((a) => a.name).sort()).toEqual(['Content Writer', 'Manager', 'Research Agent']);
    expect(s.byAgent.find((a) => a.name === 'Manager')!.sessions).toBe(2); // rencana + review
    expect(s.byObjective).toEqual([expect.objectContaining({ title: 'Statistik', sessions: 4 })]);
    expect(s.byRuntime).toEqual([expect.objectContaining({ runtime: 'fake', sessions: 4 })]);
    expect(s.usdToIdr).toBe(16000);
  });
});
