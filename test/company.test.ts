import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAgenda } from '../src/agents/schemas';
import { decisions, events, objectives } from '../src/db/schema';
import { type Company, getCompany, reviewCompany, saveCompany, setCompanyRunning, companyStatus } from '../src/orchestrator/company';
import { FakeRuntime, type FakeHandler } from '../src/runtimes/fake';
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

const charter = {
  name: 'Kopi Senja',
  businessType: 'Kedai kopi lokal dengan penjualan online',
  product: 'Biji kopi sangrai dan konten edukasi kopi',
  audience: 'Anak muda pecinta kopi',
  guidelines: 'Bahasa santai, tanpa klaim kesehatan',
  forbidden: 'politik\njudi',
  monthlyBudgetUsd: 0,
  maxActiveObjectives: 2,
  maxNewPerCycle: 2,
  cycleHours: 24,
  autoPublish: false,
};
const autopilot = async (o: Awaited<ReturnType<typeof office>>, over: Partial<typeof charter> = {}) => {
  await saveCompany(o.ctx, { ...charter, ...over });
  await setCompanyRunning(o.ctx, true);
};
const real = async (req: Parameters<FakeHandler>[0]) => new FakeRuntime().run(req, new AbortController().signal);

describe('Perusahaan otonom', () => {
  it('Owner hanya mengisi piagam: CEO menyusun agenda, objective dibuat dan dikerjakan sampai selesai', async () => {
    const o = await office();
    await autopilot(o);
    await reviewCompany(o.ctx);
    await o.worker.drain();

    const all = await o.db.select().from(objectives);
    const agenda = all.find((x) => (x.constraints as { mode?: string }).mode === 'agenda')!;
    expect(agenda.status).toBe('completed');
    const work = all.filter((x) => (x.constraints as { source?: string; mode?: string }).source === 'autopilot' && (x.constraints as { mode?: string }).mode !== 'agenda');
    expect(work.map((w) => w.title).sort()).toEqual(['Konten edukasi kopi mingguan', 'Riset kompetitor kedai kopi']);
    expect(work.every((w) => w.status === 'completed')).toBe(true);
    // Profil perusahaan sampai ke prompt agent.
    expect(o.runtime.calls.some((c) => c.systemPrompt.includes('Kedai kopi lokal dengan penjualan online'))).toBe(true);
    expect(o.runtime.calls[0]!.prompt).toContain('Pilih paling banyak 2');
  });

  it('menghormati batas objective aktif dan tidak membuat agenda baru sebelum waktunya', async () => {
    const o = await office();
    await autopilot(o, { maxActiveObjectives: 1, maxNewPerCycle: 3 });
    await reviewCompany(o.ctx);
    await o.worker.drain();
    expect((await o.db.select().from(objectives)).filter((x) => (x.constraints as { mode?: string }).mode !== 'agenda')).toHaveLength(1);

    const before = (await o.db.select().from(objectives)).length;
    await reviewCompany(o.ctx); // siklus belum jatuh tempo (jeda idle 30 menit)
    expect((await o.db.select().from(objectives)).length).toBe(before);

    // Setelah jeda lewat, agenda berikutnya dimulai.
    const c = (await getCompany(o.db))!;
    await o.ctx.db.update((await import('../src/db/schema')).settings).set({ value: { ...c, lastAgendaAt: new Date(Date.now() - 3600_000).toISOString() } as Company }).where(eq((await import('../src/db/schema')).settings.key, 'company'));
    await reviewCompany(o.ctx);
    expect((await o.db.select().from(objectives)).length).toBe(before + 1);
  });

  it('dijeda atau belum diisi: tidak ada pekerjaan yang dimulai sendiri', async () => {
    const o = await office();
    await reviewCompany(o.ctx);
    expect(await o.db.select().from(objectives)).toHaveLength(0);
    await saveCompany(o.ctx, charter);
    await reviewCompany(o.ctx); // tersimpan tetapi belum dijalankan
    expect(await o.db.select().from(objectives)).toHaveLength(0);
    expect((await companyStatus(o.ctx)).state).toBe('paused');
  });

  it('budget API bulanan habis → perusahaan dijeda dan Owner diberi tahu', async () => {
    const o = await office(async (req) => {
      const r = await real(req);
      return { ...r, usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 3_000_000 } };
    });
    await autopilot(o, { monthlyBudgetUsd: 2 });
    await reviewCompany(o.ctx);
    await o.worker.drain();
    await reviewCompany(o.ctx);
    const status = await companyStatus(o.ctx);
    expect(status.state).toBe('paused');
    expect(status.company?.pausedReason).toMatch(/Budget API bulan ini habis/);
    const notices = (await o.db.select().from(events)).filter((e) => e.type === 'owner.notified');
    expect(notices.some((n) => (n.payload as { title: string }).title.includes('budget bulanan'))).toBe(true);
  });

  it('keputusan strategis dalam batas disetujui otomatis; yang butuh akses baru dieskalasi ke Owner', async () => {
    const strategicAgenda = (decisionRequests: unknown[]): FakeHandler => async (req) => {
      const props = Object.keys((req.outputSchema as { properties?: object }).properties ?? {});
      if (props.includes('assessment')) {
        return { output: { assessment: 'x', objectives: [{ title: 'Arah produk kopi', description: 'Tentukan arah produk tahun ini.', mode: 'strategic', rationale: 'x' }], escalations: [] } };
      }
      const r = await real(req);
      if (props.includes('execution_brief')) return { ...r, output: { ...(r.output as object), owner_requests: decisionRequests } };
      return r;
    };

    const ok = await office(strategicAgenda([]));
    await autopilot(ok);
    await reviewCompany(ok.ctx);
    await ok.worker.drain();
    const [d] = await ok.db.select().from(decisions);
    expect(d!.status).toBe('approved');
    expect((await ok.db.select().from(objectives).where(eq(objectives.title, 'Arah produk kopi')))[0]!.status).toBe('completed');
    await cleanup?.();

    const blocked = await office(strategicAgenda([{ type: 'tool', key: 'instagram', reason: 'Perlu akun Instagram' }]));
    await autopilot(blocked);
    await reviewCompany(blocked.ctx);
    await blocked.worker.drain();
    const [d2] = await blocked.db.select().from(decisions);
    expect(d2!.status).toBe('proposed');
    const obj = (await blocked.db.select().from(objectives).where(eq(objectives.title, 'Arah produk kopi')))[0]!;
    expect(obj.status).toBe('awaiting_approval');
    const notice = (await blocked.db.select().from(events)).find((e) => e.type === 'owner.notified' && (e.payload as { title: string }).title.startsWith('Perlu keputusan Anda'));
    expect((notice!.payload as { message: string }).message).toMatch(/instagram/i);
  });

  it('checkAgenda menolak duplikat, kelebihan jumlah, dan larangan Owner', () => {
    const mk = (title: string, description = 'Deskripsi yang cukup panjang.') => ({ title, description, mode: 'planned' as const, rationale: 'x' });
    const agenda = (...objs: ReturnType<typeof mk>[]) => ({ assessment: 'x', objectives: objs, escalations: [] });
    const input = { maxNew: 1, existingTitles: ['Konten kopi'], forbidden: 'politik\njudi' };
    expect(checkAgenda(agenda(mk('Riset pasar kopi')), input)).toBeNull();
    expect(checkAgenda(agenda(mk('Riset pasar kopi'), mk('Konten baru lagi')), input)).toMatch(/Maksimal 1/);
    expect(checkAgenda(agenda(mk('konten  KOPI!')), input)).toMatch(/sudah ada/);
    expect(checkAgenda(agenda(mk('Opini politik kopi')), input)).toMatch(/melanggar batasan/);
  });
});
