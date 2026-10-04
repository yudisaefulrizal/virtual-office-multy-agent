import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccessGate } from '../src/interface/http/access';
import { buildServer } from '../src/interface/http/server';
import { SecretBox } from '../src/secrets';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('Dashboard hanya untuk komputer ini', () => {
  it('lewat alamat publik/tunnel semuanya ditolak', async () => {
    const o = await setupOffice();
    const app = buildServer(o.ctx, o.worker, '/tidak-ada');
    cleanup = async () => (await app.close(), await o.worker.stop(), await o.close());
    const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

    // Lokal: normal.
    expect((await get('/api/settings', { host: 'localhost:8070' })).statusCode).toBe(200);
    expect((await get('/api/settings', { host: '127.0.0.1:8070' })).statusCode).toBe(200);

    // Host publik: ditolak, termasuk API dan penulisan.
    expect((await get('/api/settings', { host: 'vo.nuscode.id' })).statusCode).toBe(404);
    expect((await get('/', { host: 'vo.nuscode.id' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/providers/openrouter', headers: { host: 'vo.nuscode.id' } })).statusCode).toBe(404);

    // Tunnel yang menulis ulang Host ke localhost tetap ketahuan dari header proxy.
    for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
      expect((await get('/api/settings', { host: 'localhost:8070', [h]: '1.2.3.4' })).statusCode).toBe(404);
    }

  });
});

describe('Kode akses untuk alamat publik (VO_ACCESS_CODE)', () => {
  const CODE = 'kode-rahasia-vo-2026';
  const pub = (extra: Record<string, string> = {}) => ({ host: 'vo.nuscode.id', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https', ...extra });

  async function boot(code = CODE) {
    const o = await setupOffice();
    const web = await mkdtemp(path.join(os.tmpdir(), 'vo-web-'));
    await writeFile(path.join(web, 'index.html'), '<html>login</html>');
    const app = buildServer(o.ctx, o.worker, web, { accessCode: code });
    cleanup = async () => (await app.close(), await o.worker.stop(), await o.close());
    return { o, app };
  }
  const login = (app: Awaited<ReturnType<typeof boot>>['app'], code: string, headers = pub()) => app.inject({ method: 'POST', url: '/api/login', headers, payload: { code } });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;

  it('tanpa masuk: data 401, halaman masuk tetap termuat, sesi dilaporkan', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: pub() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: pub(), payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/stream', headers: pub() })).statusCode).toBe(401);
    const page = await app.inject({ method: 'GET', url: '/', headers: pub() });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('login');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: pub() })).json()).toEqual({ required: true, authenticated: false });
  });

  it('kode salah ditolak; kode benar memberi cookie HttpOnly/Strict/Secure yang membuka API', async () => {
    const { app } = await boot();
    const bad = await login(app, 'salah-salah-salah');
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();

    const ok = await login(app, CODE);
    expect(ok.statusCode).toBe(200);
    const raw = String(ok.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Secure/);
    expect(raw).not.toContain(CODE);

    const cookie = cookieOf(ok);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: pub({ cookie }) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: pub({ cookie }) })).json()).toEqual({ required: true, authenticated: true });

    // Keluar menghapus cookie.
    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: pub({ cookie }) });
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('cookie palsu, rusak, atau kedaluwarsa tidak diterima', async () => {
    const { app } = await boot();
    const cookie = cookieOf(await login(app, CODE));
    const [name, value] = cookie.split('=') as [string, string];
    const [exp, sig] = value.split('.') as [string, string];
    const status = (c: string) => app.inject({ method: 'GET', url: '/api/settings', headers: pub({ cookie: c }) }).then((r) => r.statusCode);
    expect(await status(`${name}=${exp}.${sig.slice(0, -2)}xx`)).toBe(401);
    expect(await status(`${name}=${Number(exp) + 1000}.${sig}`)).toBe(401); // masa berlaku tidak bisa diperpanjang sendiri
    expect(await status(`${name}=${Date.now() - 1000}.${sig}`)).toBe(401);
    expect(await status(`${name}=`)).toBe(401);
    expect(await status(cookie)).toBe(200);
  });

  it('mengganti kode memutus sesi lama', async () => {
    const first = await boot();
    const cookie = cookieOf(await login(first.app, CODE));
    await cleanup?.();
    const second = await boot('kode-baru-yang-lain-1');
    expect((await second.app.inject({ method: 'GET', url: '/api/settings', headers: pub({ cookie }) })).statusCode).toBe(401);
  });

  it('/mcp tidak pernah terbuka dari luar, walau sudah masuk; lokal langsung tetap bebas', async () => {
    const { app } = await boot();
    const cookie = cookieOf(await login(app, CODE));
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: pub({ cookie }), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'localhost:8070' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'localhost:8070' } })).json()).toEqual({ required: false, authenticated: true });
    // Tunnel yang menulis ulang Host ke localhost tetap dianggap luar.
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'localhost:8070', 'cf-connecting-ip': '1.2.3.4' } })).statusCode).toBe(401);
  });

  it('gambar post tetap publik tanpa masuk', async () => {
    const { o, app } = await boot();
    const { createPostImage } = await import('../src/orchestrator/imagegen');
    const { file } = await createPostImage(o.ctx, { text: 'publik' });
    expect((await app.inject({ method: 'GET', url: `/media/${file}`, headers: pub() })).statusCode).toBe(200);
  });

  it('percobaan beruntun dikunci per alamat; alamat lain tidak terdampak', async () => {
    const { app } = await boot();
    for (let i = 0; i < 5; i++) expect((await login(app, 'salah-salah-salah')).statusCode).toBe(401);
    const locked = await login(app, CODE); // kode benar pun ditolak selama dikunci
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(app, CODE, pub({ 'x-forwarded-for': '9.9.9.9' }))).statusCode).toBe(200);
  });

  it('kunci total menahan serangan dari banyak alamat palsu', () => {
    const gate = new AccessGate(CODE, new SecretBox('ab'.repeat(32)));
    const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip }, ip: '127.0.0.1' }) as never;
    for (let i = 0; i < 100; i++) expect(gate.attempt(from(`10.0.${Math.floor(i / 250)}.${i % 250}`), 'salah-salah-salah')).toBeNull();
    expect(gate.locked(from('8.8.8.8'))).toBeGreaterThan(0);
    // Setelah jendela lewat, terbuka lagi.
    expect(gate.locked(from('8.8.8.8'), Date.now() + 16 * 60_000)).toBe(0);
  });

  it('kode terlalu pendek ditolak saat start; tanpa kode alamat publik tetap 404', async () => {
    const o = await setupOffice();
    cleanup = async () => (await o.worker.stop(), await o.close());
    expect(() => buildServer(o.ctx, o.worker, undefined, { accessCode: 'pendek' })).toThrow('minimal 10');
    const app = buildServer(o.ctx, o.worker);
    expect((await app.inject({ method: 'POST', url: '/api/login', headers: pub(), payload: { code: CODE } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: pub() })).statusCode).toBe(404);
    await app.close();
  });
});
