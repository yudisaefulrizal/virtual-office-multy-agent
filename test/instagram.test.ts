import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instagramAccounts, instagramStates, toolCredentials } from '../src/db/schema';
import {
  disconnectInstagram,
  finishInstagramLogin,
  instagramOverview,
  publishInstagramImage,
  refreshExpiringInstagram,
  refreshInstagram,
  setInstagramApp,
  startInstagramLogin,
} from '../src/orchestrator/instagram';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
let meta: Server;
let seen: string[];
let statusSequence: string[];

beforeEach(async () => {
  seen = [];
  statusSequence = ['IN_PROGRESS', 'FINISHED'];
  meta = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      seen.push(`${req.method} ${url.pathname}${url.search} ${body} auth=${req.headers.authorization ?? ''}`);
      const send = (o: unknown, code = 200) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (url.pathname === '/oauth/access_token') return send(body.includes('code=bad') ? { error: 'x' } : { access_token: 'short-tok', user_id: 1789, permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }, body.includes('code=bad') ? 400 : 200);
      if (url.pathname === '/access_token') return send({ access_token: 'long-token-ABCD', expires_in: 5184000 });
      if (url.pathname === '/me') return send({ user_id: '1789', username: 'kopisenja', account_type: 'BUSINESS' });
      if (url.pathname === '/refresh_access_token') return send({ access_token: 'refreshed-token-WXYZ', expires_in: 5184000 });
      if (url.pathname === '/v23.0/1789/media') return send({ id: '555' });
      if (url.pathname === '/v23.0/555') return send({ status_code: statusSequence.shift() ?? 'FINISHED' });
      if (url.pathname === '/v23.0/1789/media_publish') return send({ id: '999' });
      send({ error: { message: 'tidak ada' } }, 404);
    });
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
  process.env.INSTAGRAM_AUTHORIZE_URL = `${base}/authorize`;
  process.env.INSTAGRAM_TOKEN_URL = `${base}/oauth/access_token`;
  process.env.INSTAGRAM_GRAPH_URL = base;
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  await new Promise((r) => meta.close(r));
  delete process.env.INSTAGRAM_AUTHORIZE_URL;
  delete process.env.INSTAGRAM_TOKEN_URL;
  delete process.env.INSTAGRAM_GRAPH_URL;
});

async function office() {
  const o = await setupOffice();
  o.ctx.appOrigin = 'https://vo.example.com';
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('Instagram Login resmi', () => {
  it('menolak memulai login sebelum App ID/Secret diisi, dan memvalidasi App ID', async () => {
    const o = await office();
    await expect(startInstagramLogin(o.ctx)).rejects.toThrow(/App ID dan App Secret/);
    await expect(setInstagramApp(o.ctx, { appId: 'abc', appSecret: 'x' })).rejects.toThrow(/angka/);
    await expect(setInstagramApp(o.ctx, { appId: '123456789' })).rejects.toThrow(/App Secret wajib/);
  });

  it('login penuh: izin → token panjang terenkripsi → akun terhubung; state hanya sekali pakai', async () => {
    const o = await office();
    await setInstagramApp(o.ctx, { appId: '123456789', appSecret: 'app-secret-1234' });
    const overview0 = await instagramOverview(o.ctx);
    expect(overview0.app).toMatchObject({ configured: true, appId: '123456789', secretLast4: '1234', redirectUri: 'https://vo.example.com/auth/instagram/callback' });
    expect(JSON.stringify(overview0)).not.toContain('app-secret');

    const { url } = await startInstagramLogin(o.ctx);
    const u = new URL(url);
    expect(u.searchParams.get('client_id')).toBe('123456789');
    expect(u.searchParams.get('redirect_uri')).toBe('https://vo.example.com/auth/instagram/callback');
    expect(u.searchParams.get('scope')).toContain('instagram_business_content_publish');
    expect((await o.db.select().from(instagramStates)).length).toBe(1);

    const state = stateOf(url);
    expect(await finishInstagramLogin(o.ctx, { code: 'abc#_', state })).toEqual({ result: 'connected', username: 'kopisenja' });
    const [row] = await o.db.select().from(instagramAccounts);
    expect(row).toMatchObject({ igUserId: '1789', username: 'kopisenja', status: 'active' });
    expect(row!.tokenEnc).not.toContain('long-token');
    expect(o.ctx.secrets.decrypt(row!.tokenEnc)).toBe('long-token-ABCD');
    expect(seen.some((l) => l.includes('code=abc') && !l.includes('%23_'))).toBe(true); // "#_" dibuang

    const overview = await instagramOverview(o.ctx);
    expect(overview.accounts).toEqual([expect.objectContaining({ id: '1789', username: 'kopisenja', status: 'active', canPublish: true })]);
    expect(overview.accounts[0]!.daysLeft).toBeGreaterThan(55);
    expect(JSON.stringify(overview)).not.toContain('long-token');

    // State dipakai ulang atau palsu → error; batal di Instagram → cancelled.
    expect(await finishInstagramLogin(o.ctx, { code: 'abc', state })).toEqual({ result: 'error' });
    expect(await finishInstagramLogin(o.ctx, { code: 'abc', state: 'palsu' })).toEqual({ result: 'error' });
    const second = await startInstagramLogin(o.ctx);
    expect(await finishInstagramLogin(o.ctx, { error: 'access_denied', state: stateOf(second.url) })).toEqual({ result: 'cancelled' });
  });

  it('Meta menolak kode → error jelas tanpa menyimpan akun', async () => {
    const o = await office();
    await setInstagramApp(o.ctx, { appId: '123456789', appSecret: 'app-secret-1234' });
    const { url } = await startInstagramLogin(o.ctx);
    await expect(finishInstagramLogin(o.ctx, { code: 'bad', state: stateOf(url) })).rejects.toThrow(/Instagram menolak/);
    expect(await o.db.select().from(instagramAccounts)).toHaveLength(0);
  });

  it('memperpanjang token; yang masih lama tidak disentuh, yang hampir habis diperpanjang otomatis', async () => {
    const o = await office();
    await setInstagramApp(o.ctx, { appId: '123456789', appSecret: 'app-secret-1234' });
    const { url } = await startInstagramLogin(o.ctx);
    await finishInstagramLogin(o.ctx, { code: 'abc', state: stateOf(url) });

    await refreshExpiringInstagram(o.ctx); // masih ±60 hari: tidak ada permintaan refresh
    expect(seen.some((l) => l.includes('/refresh_access_token'))).toBe(false);

    await o.db.update(instagramAccounts).set({ expiresAt: new Date(Date.now() + 5 * 86_400_000) });
    await refreshExpiringInstagram(o.ctx);
    const [row] = await o.db.select().from(instagramAccounts);
    expect(o.ctx.secrets.decrypt(row!.tokenEnc)).toBe('refreshed-token-WXYZ');
    expect((await instagramOverview(o.ctx)).accounts[0]!.daysLeft).toBeGreaterThan(55);

    await o.db.update(instagramAccounts).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(refreshInstagram(o.ctx, '1789')).rejects.toThrow(/hubungkan Instagram lagi/);
    expect((await instagramOverview(o.ctx)).accounts[0]!.status).toBe('expired');
  });

  it('menerbitkan gambar: container → tunggu FINISHED → media_publish; akun tanpa izin posting ditolak', async () => {
    const o = await office();
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/a.jpg', caption: 'x' })).rejects.toThrow(/Belum ada akun Instagram/);

    await setInstagramApp(o.ctx, { appId: '123456789', appSecret: 'app-secret-1234' });
    const { url } = await startInstagramLogin(o.ctx);
    await finishInstagramLogin(o.ctx, { code: 'abc', state: stateOf(url) });
    const res = await publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/a.jpg', caption: 'Kopi pagi' }, { pollMs: 1 });
    expect(res).toEqual({ mediaId: '999', username: 'kopisenja' });
    const media = seen.find((l) => l.includes('POST /v23.0/1789/media '))!;
    expect(media).toContain('image_url=https%3A%2F%2Fcdn.example.com%2Fa.jpg');
    expect(media).toContain('auth=Bearer long-token-ABCD');
    expect(seen.filter((l) => l.includes('/v23.0/555')).length).toBe(2); // IN_PROGRESS lalu FINISHED

    statusSequence = ['ERROR'];
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/b.jpg', caption: 'x' }, { pollMs: 1 })).rejects.toThrow(/ditolak \(ERROR\)/);

    await o.db.update(instagramAccounts).set({ permissions: 'instagram_business_basic' });
    await expect(publishInstagramImage(o.ctx, { imageUrl: 'https://cdn.example.com/c.jpg', caption: 'x' })).rejects.toThrow(/Belum ada akun Instagram/);
  });

  it('memutus akun menghapus token; App Secret tersimpan terenkripsi', async () => {
    const o = await office();
    await setInstagramApp(o.ctx, { appId: '123456789', appSecret: 'app-secret-1234' });
    const [cred] = await o.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, 'instagram_login_app'));
    expect(cred!.secretEnc).not.toContain('app-secret');
    const { url } = await startInstagramLogin(o.ctx);
    await finishInstagramLogin(o.ctx, { code: 'abc', state: stateOf(url) });
    await disconnectInstagram(o.ctx, '1789');
    expect(await o.db.select().from(instagramAccounts)).toHaveLength(0);
    await expect(disconnectInstagram(o.ctx, '1789')).rejects.toThrow(/tidak ditemukan/);
  });
});
