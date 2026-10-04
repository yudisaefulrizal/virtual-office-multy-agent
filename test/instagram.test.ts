import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolCredentials } from '../src/db/schema';
import { instagramOverview, publishInstagramImage, removeInstagramKey, setInstagramKey } from '../src/orchestrator/instagram';
import { setupOffice } from './helpers';

const KEY = `ncig_${'ab12cd34'.repeat(8)}`;

let cleanup: (() => Promise<void>) | undefined;
let ncwa: Server;
let seen: string[];
let postSequence: string[];
let canPublish: boolean;

beforeEach(async () => {
  seen = [];
  postSequence = ['processing', 'published'];
  canPublish = true;
  ncwa = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body} auth=${req.headers.authorization ?? ''}`);
      const send = (o: unknown, code = 200) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (req.headers.authorization !== `Bearer ${KEY}`) return send({ error: 'unauthorized', message: 'key salah' }, 401);
      if (req.url === '/accounts') return send([{ id: '1789', username: 'kopisenja', status: 'active', daysLeft: 40, permissions: canPublish ? ['instagram_business_basic', 'instagram_business_content_publish'] : ['instagram_business_basic'] }]);
      if (req.method === 'POST' && req.url === '/posts') return send({ requestId: JSON.parse(body).requestId, status: 'preparing', mediaId: null }, 202);
      if (req.url?.startsWith('/posts/')) {
        const status = postSequence.shift() ?? 'published';
        return send({ requestId: req.url.slice(7), status, mediaId: status === 'published' ? '999' : null });
      }
      send({ error: 'not_found', message: 'tidak ada' }, 404);
    });
  });
  await new Promise<void>((r) => ncwa.listen(0, '127.0.0.1', r));
  process.env.NCWA_INSTAGRAM_URL = `http://127.0.0.1:${(ncwa.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  await new Promise((r) => ncwa.close(r));
  delete process.env.NCWA_INSTAGRAM_URL;
});

async function office() {
  const o = await setupOffice();
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}

describe('Instagram lewat NC-WA', () => {
  it('menolak key berbentuk salah atau ditolak NC-WA tanpa menyimpan apa pun', async () => {
    const o = await office();
    await expect(setInstagramKey(o.ctx, { apiKey: 'abc' })).rejects.toThrow(/ncig_/);
    await expect(setInstagramKey(o.ctx, { apiKey: `ncig_${'ee'.repeat(32)}` })).rejects.toThrow(/tidak valid/);
    expect(await o.db.select().from(toolCredentials)).toHaveLength(0);
  });

  it('menyimpan key terenkripsi dan menampilkan akun dari NC-WA tanpa membocorkan key', async () => {
    const o = await office();
    expect(await instagramOverview(o.ctx)).toEqual({ configured: false, last4: null, accounts: [], error: null });
    await setInstagramKey(o.ctx, { apiKey: `NCWA_apikey="${KEY}"\n` });
    const [cred] = await o.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, 'ncwa_instagram'));
    expect(cred!.secretEnc).not.toContain('ab12cd34');
    expect(o.ctx.secrets.decrypt(cred!.secretEnc)).toBe(KEY);
    const overview = await instagramOverview(o.ctx);
    expect(overview).toMatchObject({ configured: true, last4: 'cd34', error: null, accounts: [{ id: '1789', username: 'kopisenja', status: 'active', daysLeft: 40, canPublish: true }] });
    expect(JSON.stringify(overview)).not.toContain('ab12cd34');

    await removeInstagramKey(o.ctx);
    expect((await instagramOverview(o.ctx)).configured).toBe(false);
  });

  it('key yang kemudian dicabut di NC-WA muncul sebagai pesan, bukan error', async () => {
    const o = await office();
    await setInstagramKey(o.ctx, { apiKey: KEY });
    await o.db.update(toolCredentials).set({ secretEnc: o.ctx.secrets.encrypt(`ncig_${'ff'.repeat(32)}`) });
    expect(await instagramOverview(o.ctx)).toMatchObject({ configured: true, accounts: [], error: expect.stringMatching(/tidak valid/) });
  });

  it('menerbitkan gambar: POST /posts lalu memantau sampai published', async () => {
    const o = await office();
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/a.jpg', caption: 'x' })).rejects.toThrow(/Belum ada akun Instagram/);

    await setInstagramKey(o.ctx, { apiKey: KEY });
    const res = await publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/a.jpg', caption: 'Kopi pagi' }, { pollMs: 1 });
    expect(res).toEqual({ mediaId: '999', username: 'kopisenja' });
    const post = seen.find((l) => l.startsWith('POST /posts '))!;
    const sent = JSON.parse(post.slice(post.indexOf('{'), post.lastIndexOf('}') + 1));
    expect(sent).toMatchObject({ igUserId: '1789', imageUrl: 'https://cdn.example.com/a.jpg', caption: 'Kopi pagi' });
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(post).toContain(`auth=Bearer ${KEY}`);
    expect(seen.filter((l) => l.startsWith(`GET /posts/${sent.requestId}`))).toHaveLength(2); // processing lalu published
  });

  it('melaporkan failed dan unknown sebagai gagal; akun tanpa izin posting ditolak', async () => {
    const o = await office();
    await setInstagramKey(o.ctx, { apiKey: KEY });
    postSequence = ['failed'];
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/b.jpg', caption: 'x' }, { pollMs: 1 })).rejects.toThrow(/ditolak/);
    postSequence = ['unknown'];
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/b.jpg', caption: 'x' }, { pollMs: 1 })).rejects.toThrow(/belum pasti/);
    postSequence = ['processing', 'processing', 'processing'];
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/b.jpg', caption: 'x' }, { pollMs: 1, maxPolls: 2 })).rejects.toThrow(/terlalu lama/);

    canPublish = false;
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/c.jpg', caption: 'x' })).rejects.toThrow(/Belum ada akun Instagram/);
  });
});
