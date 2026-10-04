import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, approvals } from '../src/db/schema';
import { Gateway } from '../src/gateway/gateway';
import type { Caller } from '../src/gateway/tools';
import { buildServer } from '../src/interface/http/server';
import { createPostImage, imageSize, imageUsage, mediaPath, removeImageModel, renderTextImage, setImageModel } from '../src/orchestrator/imagegen';
import { setInstagramKey } from '../src/orchestrator/instagram';
import { setSetting } from '../src/orchestrator/settings';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
let router: Server;
/** Gambar yang dikembalikan OpenRouter tiruan; null = respons tanpa gambar. */
let modelImage: Buffer | null;
let routerHits: number;
let routerStatus: number;
/** true = meniru model khusus gambar (Seedream): menolak permintaan image+text dengan 404. */
let imageOnly: boolean;
let modalitiesSeen: string[];

beforeEach(async () => {
  routerHits = 0;
  routerStatus = 200;
  imageOnly = false;
  modalitiesSeen = [];
  modelImage = await renderTextImage('dari model');
  router = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      routerHits++;
      const modalities = (JSON.parse(body).modalities as string[]).join('+');
      modalitiesSeen.push(modalities);
      if (imageOnly && modalities !== 'image') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'No endpoints found that support the requested output modalities: image, text' } }));
      }
      res.writeHead(routerStatus, { 'content-type': 'application/json' });
      if (routerStatus !== 200) return res.end(JSON.stringify({ error: { message: 'kredit habis' } }));
      const images = modelImage ? [{ image_url: { url: `data:image/png;base64,${modelImage.toString('base64')}` } }] : [];
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok', images } }], usage: { cost: 0.04 } }));
    });
  });
  await new Promise<void>((r) => router.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_URL = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup?.();
  cleanup = undefined;
  await new Promise((r) => router.close(r));
  delete process.env.OPENROUTER_URL;
});

async function office() {
  const o = await setupOffice();
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}

const MODEL = { apiKey: 'sk-or-test-1234', model: 'google/gemini-2.5-flash-image', enabled: true };

describe('Gambar post', () => {
  it('renderer sendiri menghasilkan PNG 4:5 putih; emoji tidak merusak', async () => {
    const png = await renderTextImage('Kopi pagi bikin semangat ☕🙂 mulai hari dengan senyum');
    expect(imageSize(png)).toEqual({ width: 1080, height: 1350, ext: 'png' });
    expect((await renderTextImage('x'.repeat(1000))).length).toBeGreaterThan(1000);
  });

  it('tanpa model gambar: teks di latar putih, tidak memanggil OpenRouter', async () => {
    const o = await office();
    const img = await createPostImage(o.ctx, { text: 'Halo dunia' });
    expect(img).toMatchObject({ source: 'text' });
    expect(imageSize(await readFile(mediaPath(o.ctx, img.file)))).toMatchObject({ width: 1080, height: 1350 });
    expect(routerHits).toBe(0);
  });

  it('model aktif: dipakai, biayanya tercatat; kunci tidak pernah kembali ke UI', async () => {
    const o = await office();
    await setImageModel(o.ctx, MODEL);
    const img = await createPostImage(o.ctx, { text: 'Halo', prompt: 'cangkir kopi' });
    expect(img.source).toBe('model');
    expect(routerHits).toBe(1);
    expect((await imageUsage(o.ctx)).day).toEqual({ count: 1, costUsd: 0.04 });
  });

  it('dinonaktifkan atau dihapus → kembali ke teks', async () => {
    const o = await office();
    await setImageModel(o.ctx, { ...MODEL, enabled: false });
    expect(await createPostImage(o.ctx, { text: 'a' })).toMatchObject({ source: 'text', reason: expect.stringContaining('dinonaktifkan') });
    await setImageModel(o.ctx, { model: MODEL.model, enabled: true }); // key lama dipertahankan
    expect((await createPostImage(o.ctx, { text: 'a' })).source).toBe('model');
    await removeImageModel(o.ctx);
    expect((await createPostImage(o.ctx, { text: 'a' })).source).toBe('text');
  });

  it('kuota jumlah dan biaya dari Owner: lewat batas → teks, post tidak tertunda', async () => {
    const o = await office();
    await setImageModel(o.ctx, MODEL);
    await setSetting(o.db, 'image_max_per_day', 2);
    expect((await createPostImage(o.ctx, { text: 'a' })).source).toBe('model');
    expect((await createPostImage(o.ctx, { text: 'b' })).source).toBe('model');
    expect(await createPostImage(o.ctx, { text: 'c' })).toMatchObject({ source: 'text', reason: expect.stringContaining('kuota 2 gambar') });
    expect(routerHits).toBe(2);

    await setSetting(o.db, 'image_max_per_day', 0); // 0 = tanpa batas jumlah
    await setSetting(o.db, 'image_max_cost_usd_per_day', 0.1); // 2 × $0.04 = $0.08 < $0.1
    expect((await createPostImage(o.ctx, { text: 'd' })).source).toBe('model'); // total $0.12
    expect(await createPostImage(o.ctx, { text: 'e' })).toMatchObject({ source: 'text', reason: expect.stringContaining('biaya') });
  });

  it('model gagal atau mengembalikan gambar yang tidak cocok → cadangan teks', async () => {
    const o = await office();
    await setImageModel(o.ctx, MODEL);
    routerStatus = 402;
    expect(await createPostImage(o.ctx, { text: 'a' })).toMatchObject({ source: 'text', reason: expect.stringContaining('kredit habis') });
    routerStatus = 200;
    modelImage = null;
    expect(await createPostImage(o.ctx, { text: 'a' })).toMatchObject({ source: 'text', reason: expect.stringContaining('tidak mengembalikan gambar') });
    // Persegi panjang mendatar (rasio 1.91:1) ditolak Instagram lewat NC-WA; sisi penerima menolak sebelum dikirim.
    const wide = Buffer.alloc(40);
    wide.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
    wide.writeUInt32BE(1910, 16);
    wide.writeUInt32BE(1000, 20);
    modelImage = wide;
    expect(await createPostImage(o.ctx, { text: 'a' })).toMatchObject({ source: 'text', reason: expect.stringContaining('di luar 1:1–4:5') });
    expect((await imageUsage(o.ctx)).day).toEqual({ count: 1, costUsd: 0.04 }); // hanya yang sudah berbiaya (rasio salah) yang dihitung
  });

  it('model khusus gambar (Seedream): menolak image+text, otomatis diulang dengan image saja', async () => {
    const o = await office();
    await setImageModel(o.ctx, { ...MODEL, model: 'bytedance-seed/seedream-4.5' });
    imageOnly = true;
    expect((await createPostImage(o.ctx, { text: 'a' })).source).toBe('model');
    expect(modalitiesSeen).toEqual(['image+text', 'image']);
    // Gambar berikutnya langsung memakai bentuk yang diterima, tanpa percobaan yang pasti ditolak.
    expect((await createPostImage(o.ctx, { text: 'b' })).source).toBe('model');
    expect(modalitiesSeen).toEqual(['image+text', 'image', 'image']);
    expect((await imageUsage(o.ctx)).day.count).toBe(2);
  });

  it('gagal tanpa biaya tidak menghabiskan kuota jumlah', async () => {
    const o = await office();
    await setImageModel(o.ctx, MODEL);
    routerStatus = 402;
    for (let i = 0; i < 4; i++) expect((await createPostImage(o.ctx, { text: 'a' })).source).toBe('text');
    expect((await imageUsage(o.ctx)).day).toEqual({ count: 0, costUsd: 0 });
  });

  it('format model harus vendor/model', async () => {
    const o = await office();
    await expect(setImageModel(o.ctx, { apiKey: 'k', model: 'tanpa-vendor', enabled: true })).rejects.toThrow('vendor/model');
  });
});

describe('Publikasi dengan gambar buatan sistem', () => {
  const KEY = `ncig_${'ab12cd34'.repeat(8)}`;

  async function writerCaller(db: Awaited<ReturnType<typeof office>>['db']): Promise<Caller> {
    const [a] = await db.select().from(agents).where(eq(agents.roleId, 'content_writer'));
    return { agentId: a!.id, agentName: a!.name, roleId: 'content_writer', taskId: '00000000-0000-0000-0000-000000000001', sessionId: '00000000-0000-0000-0000-000000000002', objectiveId: '00000000-0000-0000-0000-000000000000' };
  }

  it('gambar dibuat saat diminta (Owner bisa melihatnya), URL publik dipakai saat disetujui', async () => {
    const o = await office();
    const gw = new Gateway(o.ctx, 'http://x');
    o.ctx.gateway = gw;
    const caller = await writerCaller(o.db);

    expect((await gw.call(caller, 'instagram_publish', { caption: 'c' })).message).toContain('image_text');

    await gw.call(caller, 'instagram_publish', { caption: 'Kopi pagi', image_text: 'Kopi pagi' });
    const [a] = await o.db.select().from(approvals);
    const args = a!.args as { image_file: string; image_source: string };
    expect(args.image_source).toBe('text');
    expect(imageSize(await readFile(mediaPath(o.ctx, args.image_file)))).toMatchObject({ width: 1080 });

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url} ${String(init?.body ?? '')}`);
      const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
      if (url.endsWith('/accounts')) return json([{ id: '1789', username: 'kopisenja', status: 'active', permissions: ['instagram_business_content_publish'] }]);
      if (init?.method === 'POST') return json({ requestId: 'r', status: 'preparing', mediaId: null }, 202);
      return json({ requestId: 'r', status: 'published', mediaId: '999' });
    });
    await setInstagramKey(o.ctx, { apiKey: KEY });

    // Alamat publik belum diisi → gagal dengan pesan jelas, bukan mengirim alamat lokal.
    const noBase = await gw.approve(a!.id);
    expect(noBase.ok).toBe(false);
    expect(noBase.message).toContain('Alamat publik server belum diisi');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);

    await gw.call(caller, 'instagram_publish', { caption: 'Kopi sore', image_text: 'Kopi sore' });
    const [pending] = await o.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    await setSetting(o.db, 'public_base_url', 'https://kantor.contoh.id/');
    const ok = await gw.approve(pending!.id);
    expect(ok).toMatchObject({ ok: true, result: { mediaId: '999' } });
    const file = (pending!.args as { image_file: string }).image_file;
    expect(calls.find((c) => c.startsWith('POST'))).toContain(`"imageUrl":"https://kantor.contoh.id/media/${file}"`);
  });
});

describe('Server', () => {
  it('hanya /media/<acak>.png yang terbuka dari luar; API tetap tertutup', async () => {
    const o = await office();
    const app = buildServer(o.ctx, o.worker, '/tidak-ada');
    cleanup = async () => (await app.close(), await o.worker.stop(), await o.close());
    const { file } = await createPostImage(o.ctx, { text: 'publik' });
    const outside = { host: 'kantor.contoh.id', 'x-forwarded-for': '1.2.3.4' };

    const img = await app.inject({ method: 'GET', url: `/media/${file}`, headers: outside });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    expect((await app.inject({ method: 'GET', url: '/media/../.vo-secret', headers: outside })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/media/abc.png', headers: outside })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/media/${'0'.repeat(32)}.png`, headers: { host: 'localhost:8070' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/image-model', headers: outside })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/image-model/test', headers: outside })).statusCode).toBe(404);

    // Pengaturan kuota lewat API lokal; URL publik harus http(s).
    const local = { host: 'localhost:8070' };
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/settings', headers: local, payload });
    expect((await put({ image_max_per_day: 5, image_max_cost_usd_per_day: 0.5, public_base_url: 'https://kantor.contoh.id' })).json()).toMatchObject({ image_max_per_day: 5, image_max_cost_usd_per_day: 0.5 });
    expect((await put({ public_base_url: 'javascript:alert(1)' })).statusCode).toBe(400);
    const saved = await app.inject({ method: 'PUT', url: '/api/image-model', headers: local, payload: { apiKey: 'sk-or-abcd1234', model: 'google/gemini-2.5-flash-image', enabled: true } });
    expect(saved.json()).toMatchObject({ configured: true, last4: '1234', enabled: true });
    expect(JSON.stringify(saved.json())).not.toContain('sk-or-abcd');
  });
});
