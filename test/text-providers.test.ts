import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { agents } from '../src/db/schema';
import { INITIAL_AGENTS, decisionInstructions } from '../src/agents/roles';
import { buildServer } from '../src/interface/http/server';
import { applyOrgChange } from '../src/orchestrator/org';
import { listProviders, loadProviders, removeProvider, setProvider, updateAgent } from '../src/orchestrator/providers';
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

describe('Runtime teks OpenRouter dimatikan (bawaan)', () => {
  it('seed: semua karyawan awal memakai claude-cli dan aktif', async () => {
    const o = await office();
    expect(INITIAL_AGENTS.every((a) => a.runtime === 'claude-cli' && (a.status ?? 'active') === 'active')).toBe(true);
    const rows = await o.db.select().from(agents);
    expect(rows.every((a) => a.runtime === 'claude-cli' || a.runtime === 'fake')).toBe(true);
    expect(rows.some((a) => a.status === 'waiting_provider')).toBe(false);
  });

  it('prompt CEO tidak lagi menyuruh memakai openrouter', () => {
    expect(decisionInstructions().toLowerCase()).not.toContain('openrouter');
  });

  it('tidak ada provider yang terdaftar; menyimpan atau mencabutnya ditolak', async () => {
    const o = await office();
    expect(await listProviders(o.ctx)).toEqual([]);
    await expect(setProvider(o.ctx, 'openrouter', { apiKey: 'sk-or-x', defaultModel: 'a/b' })).rejects.toThrow('dinonaktifkan');
    await expect(removeProvider(o.ctx, 'openrouter')).rejects.toThrow('dinonaktifkan');
    await loadProviders(o.ctx);
    expect(o.ctx.runtimes.has('openrouter')).toBe(false);
  });

  it('agent tidak bisa dipindah atau direkrut ke openrouter', async () => {
    const o = await office();
    const [a] = await o.db.select().from(agents).where(eq(agents.roleId, 'content_writer'));
    await expect(updateAgent(o.ctx, a!.id, { runtime: 'openrouter' })).rejects.toThrow('dinonaktifkan');
    await expect(applyOrgChange(o.ctx, { type: 'hire', role_id: 'content_writer', runtime: 'openrouter', reason: 'uji' }, 'owner', 'owner')).rejects.toThrow('dinonaktifkan');
    expect((await o.db.select().from(agents).where(eq(agents.runtime, 'openrouter'))).length).toBe(0);
  });

  it('API provider tidak menampilkan apa-apa dan menolak menulis', async () => {
    const o = await office();
    const app = buildServer(o.ctx, o.worker);
    cleanup = async () => (await app.close(), await o.worker.stop(), await o.close());
    const local = { host: 'localhost:8070' };
    expect((await app.inject({ method: 'GET', url: '/api/providers', headers: local })).json()).toEqual([]);
    const put = await app.inject({ method: 'PUT', url: '/api/providers/openrouter', headers: local, payload: { apiKey: 'sk-or-x', defaultModel: 'a/b/c' } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toContain('dinonaktifkan');
  });

  it('model gambar tidak terpengaruh dan tidak membuat runtime teks', async () => {
    const o = await office();
    const { setImageModel } = await import('../src/orchestrator/imagegen');
    await setImageModel(o.ctx, { apiKey: 'sk-or-gambar-1234', model: 'google/gemini-2.5-flash-image', enabled: true });
    expect(o.ctx.runtimes.has('openrouter')).toBe(false);
    expect(await listProviders(o.ctx)).toEqual([]);
  });
});
