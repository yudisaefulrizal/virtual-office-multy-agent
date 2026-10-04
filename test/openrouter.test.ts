import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agents, providers } from '../src/db/schema';
import { listProviders, removeProvider, setProvider } from '../src/orchestrator/providers';
import { OpenRouterRuntime } from '../src/runtimes/openrouter';
import type { RunRequest } from '../src/runtimes/runtime';
import { SecretBox } from '../src/secrets';
import { setupOffice } from './helpers';

// Runtime teks OpenRouter mati secara bawaan; berkas ini menguji adapter dan jalur provider saat dinyalakan.
beforeAll(() => void (process.env.VO_TEXT_PROVIDERS = '1'));
afterAll(() => void delete process.env.VO_TEXT_PROVIDERS);

const req = async (over: Partial<RunRequest> = {}): Promise<RunRequest> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vo-or-'));
  return {
    workDir: dir, systemPrompt: 'sys', prompt: 'halo', sessionId: 's1', outputSchema: { type: 'object' },
    nativeTools: 'read_only', timeoutMs: 5000, logPath: path.join(dir, 's1.log'), ...over,
  };
};

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: any[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const r = responses.shift()!;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('OpenRouterRuntime', () => {
  it('mengirim JSON schema, membaca output, token, dan biaya nyata', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { choices: [{ message: { content: '{"analysis":"ok"}' } }], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042 } } },
    ]);
    const transcriptDir = await mkdtemp(path.join(os.tmpdir(), 'vo-tr-'));
    const rt = new OpenRouterRuntime({ apiKey: 'sk-or-test', defaultModel: 'vendor/model', transcriptDir, fetch: f });
    const r = await rt.run(await req(), new AbortController().signal);
    expect(r.status).toBe('ok');
    expect(r.output).toEqual({ analysis: 'ok' });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsdMicros: 420 });
    expect(calls[0].model).toBe('vendor/model');
    expect(calls[0].response_format.type).toBe('json_schema');
    expect(calls[0].messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('resume mengirim ulang transcript sesi sebelumnya', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { choices: [{ message: { content: 'bukan json' } }], usage: {} } },
      { status: 200, body: { choices: [{ message: { content: '{"x":1}' } }], usage: {} } },
    ]);
    const transcriptDir = await mkdtemp(path.join(os.tmpdir(), 'vo-tr-'));
    const rt = new OpenRouterRuntime({ apiKey: 'k', defaultModel: 'm', transcriptDir, fetch: f });
    const first = await rt.run(await req({ sessionId: 'a1' }), new AbortController().signal);
    expect(first.output).toBe('bukan json');
    await rt.run(await req({ sessionId: 'a2', resumeSessionId: 'a1', prompt: 'perbaiki' }), new AbortController().signal);
    expect(calls[1].messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('HTTP 429 → rate_limited dengan waktu retry', async () => {
    const { f } = fakeFetch([{ status: 429, body: 'slow down', headers: { 'retry-after': '60' } }]);
    const rt = new OpenRouterRuntime({ apiKey: 'k', defaultModel: 'm', transcriptDir: os.tmpdir(), fetch: f });
    const r = await rt.run(await req(), new AbortController().signal);
    expect(r.status).toBe('rate_limited');
    expect(r.retryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('API key tidak tertulis di log sesi', async () => {
    const { f } = fakeFetch([{ status: 200, body: { choices: [{ message: { content: '{}' } }] } }]);
    const r0 = await req();
    const rt = new OpenRouterRuntime({ apiKey: 'sk-or-SECRET-123', defaultModel: 'm', transcriptDir: os.tmpdir(), fetch: f });
    await rt.run(r0, new AbortController().signal);
    expect(await readFile(r0.logPath, 'utf8')).not.toContain('SECRET');
  });
});

describe('SecretBox', () => {
  it('enkripsi bolak-balik dan menolak data yang diubah', () => {
    const box = new SecretBox('a'.repeat(64));
    const sealed = box.encrypt('sk-or-rahasia');
    expect(sealed).not.toContain('rahasia');
    expect(box.decrypt(sealed)).toBe('sk-or-rahasia');
    const tampered = Buffer.from(sealed, 'base64');
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.decrypt(tampered.toString('base64'))).toThrow();
  });
});

/** Seed sekarang memakai claude-cli untuk semua; tes provider memulai dari agent yang sudah dipindah ke openrouter. */
const moveToOpenRouter = (o: Awaited<ReturnType<typeof setupOffice>>) =>
  o.db.update(agents).set({ runtime: 'openrouter', model: null, status: 'waiting_provider' }).where(eq(agents.name, 'Market Researcher'));

describe('Provider OpenRouter dipasang Owner', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('menyimpan key terenkripsi, mendaftarkan runtime, dan mengaktifkan agent yang menunggu', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    await moveToOpenRouter(o);
    const [mr] = await o.db.select().from(agents).where(eq(agents.name, 'Market Researcher'));
    expect(mr?.status).toBe('waiting_provider');

    await setProvider(o.ctx, 'openrouter', { apiKey: 'sk-or-abcd1234', defaultModel: 'vendor/model' });

    const [row] = await o.db.select().from(providers);
    expect(row?.apiKeyEnc).not.toContain('abcd1234');
    expect(o.ctx.secrets.decrypt(row!.apiKeyEnc)).toBe('sk-or-abcd1234');
    expect(o.ctx.runtimes.has('openrouter')).toBe(true);
    const [after] = await o.db.select().from(agents).where(eq(agents.name, 'Market Researcher'));
    expect(after).toMatchObject({ status: 'active', model: 'vendor/model' });
    expect(await listProviders(o.ctx)).toEqual([expect.objectContaining({ id: 'openrouter', configured: true, apiKeyLast4: '1234' })]);
    expect(JSON.stringify(await listProviders(o.ctx))).not.toContain('abcd1234');
    expect(o.emitted.map((e) => e.type)).toEqual(expect.arrayContaining(['provider.configured', 'agent.activated']));
  });

  it('mencabut provider: key dihapus, runtime dilepas, agent kembali menunggu provider', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    await expect(removeProvider(o.ctx, 'openrouter')).rejects.toThrow(/belum dipasang/);
    await moveToOpenRouter(o);
    await setProvider(o.ctx, 'openrouter', { apiKey: 'sk-or-abcd1234', defaultModel: 'vendor/model' });
    await removeProvider(o.ctx, 'openrouter');

    expect(await o.db.select().from(providers)).toHaveLength(0);
    expect(o.ctx.runtimes.has('openrouter')).toBe(false);
    const [mr] = await o.db.select().from(agents).where(eq(agents.name, 'Market Researcher'));
    expect(mr?.status).toBe('waiting_provider');
    expect(o.emitted.some((e) => e.type === 'provider.removed')).toBe(true);
  });
});
