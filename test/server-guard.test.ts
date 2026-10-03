import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/interface/http/server';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('Dashboard hanya untuk komputer ini', () => {
  it('lewat alamat publik/tunnel hanya callback Instagram yang dilayani', async () => {
    const o = await setupOffice();
    o.ctx.uiOrigin = 'http://localhost:8070';
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

    // Callback Instagram boleh lewat tunnel; hasilnya mengembalikan Owner ke dashboard lokal (bukan alamat publik).
    const cb = await get('/auth/instagram/callback?code=x&state=palsu', { host: 'vo.nuscode.id', 'x-forwarded-for': '1.2.3.4' });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:8070/#/access?instagram=error');
    // Tetapi bukan metode lain pada path itu.
    expect((await app.inject({ method: 'POST', url: '/auth/instagram/callback', headers: { host: 'vo.nuscode.id' } })).statusCode).toBe(404);
  });
});
