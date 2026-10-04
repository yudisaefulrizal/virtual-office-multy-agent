import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agendaInstructions } from '../src/agents/roles';
import { instagramMedia, instagramSnapshots, toolExecutions } from '../src/db/schema';
import { buildServer } from '../src/interface/http/server';
import { growthBrief, growthView } from '../src/orchestrator/growth';
import { setInstagramKey } from '../src/orchestrator/instagram';
import { collectDueMetrics, collectInstagramMetrics, refreshInstagramMetrics } from '../src/orchestrator/metrics';
import { setSetting } from '../src/orchestrator/settings';
import { setupOffice } from './helpers';

const KEY = `ncig_${'ab12cd34'.repeat(8)}`;
const ACC = '1789';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let cleanup: (() => Promise<void>) | undefined;
let ncwa: Server;
let hits: string[];
let followers: number;
let summaryScope: boolean;
let mediaScope: boolean;
let failAll: boolean;
let accountStatus: string;
/** Dua halaman media: halaman pertama punya cursor "p2". */
let likes: Record<string, number>;

const post = (id: string, caption: string, ts: string) => ({
  id,
  caption,
  media_type: 'IMAGE',
  media_url: `https://cdn.example/${id}.jpg`,
  permalink: `https://www.instagram.com/p/${id}/`,
  timestamp: ts,
  like_count: likes[id] ?? 0,
  comments_count: 1,
});

beforeEach(async () => {
  hits = [];
  followers = 120;
  summaryScope = true;
  mediaScope = true;
  failAll = false;
  accountStatus = 'active';
  likes = { m1: 10, m2: 30, m3: 5 };
  ncwa = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      const send = (o: unknown, code = 200) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      if (req.headers.authorization !== `Bearer ${KEY}`) return send({ error: 'unauthorized', message: 'key salah' }, 401);
      if (failAll && req.url !== '/accounts') return send({ error: 'meta', message: 'Meta menolak' }, 502);
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/accounts') return send([{ id: ACC, username: 'kopisenja', status: accountStatus, daysLeft: 40, permissions: [] }]);
      if (url.pathname === `/accounts/${ACC}/summary`) {
        if (!summaryScope) return send({ error: 'insufficient_scope', message: 'Key tidak punya izin insights:read' }, 403);
        return send({ id: ACC, username: 'kopisenja', followers, following: 50, mediaCount: 3, month: { from: 'a', to: 'b', views: 900, reach: 400, accounts_engaged: 40, total_interactions: 80, likes: 60, comments: 10, shares: 4, saves: 6, profile_views: 22, unavailable: [] }, fetchedAt: 'x' });
      }
      if (url.pathname === `/accounts/${ACC}/media`) {
        if (!mediaScope) return send({ error: 'insufficient_scope', message: 'Key tidak punya izin comments:read' }, 403);
        if (url.searchParams.get('after') === 'p2') return send({ data: [post('m3', 'Tips ketiga', '2026-09-01T08:00:00+0000')], next: null });
        return send({ data: [post('m1', 'Kopi pagi', '2026-09-19T11:45:13+0000'), post('m2', 'Promo akhir pekan', '2026-09-10T09:00:00+0000')], next: 'p2' });
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

async function office(withKey = true) {
  const o = await setupOffice();
  cleanup = async () => (await o.worker.stop(), await o.close());
  if (withKey) await setInstagramKey(o.ctx, { apiKey: KEY });
  return o;
}
const snap = (o: Awaited<ReturnType<typeof office>>, ageMs: number, f: number, reach: number | null = null) =>
  o.db.insert(instagramSnapshots).values({ id: randomUUID(), accountId: ACC, username: 'kopisenja', followers: f, reach, fetchedAt: new Date(Date.now() - ageMs) });

describe('Pengumpul data Instagram', () => {
  it('menyimpan snapshot akun dan semua postingan (mengikuti halaman berikutnya)', async () => {
    const o = await office();
    const st = await collectInstagramMetrics(o.ctx, 'manual');
    expect(st.accounts).toEqual([{ id: ACC, username: 'kopisenja', summary: 'ok', media: 'ok', posts: 3 }]);

    const [s] = await o.db.select().from(instagramSnapshots);
    expect(s).toMatchObject({ accountId: ACC, followers: 120, following: 50, mediaCount: 3, views: 900, reach: 400, accountsEngaged: 40, totalInteractions: 80, likes: 60, comments: 10, shares: 4, saves: 6, profileViews: 22 });
    const media = await o.db.select().from(instagramMedia);
    expect(media.map((m) => m.mediaId).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(media.find((m) => m.mediaId === 'm1')).toMatchObject({ caption: 'Kopi pagi', likeCount: 10, commentsCount: 1, mediaType: 'IMAGE', permalink: 'https://www.instagram.com/p/m1/' });
    expect(media.find((m) => m.mediaId === 'm1')!.postedAt!.toISOString()).toBe('2026-09-19T11:45:13.000Z');
    expect(hits.some((h) => h.includes('after=p2'))).toBe(true);
    expect(o.emitted.some((e) => e.type === 'metrics.collected')).toBe(true);
  });

  it('pengambilan berikutnya menambah snapshot dan memperbarui postingan tanpa duplikat', async () => {
    const o = await office();
    await collectInstagramMetrics(o.ctx, 'manual');
    followers = 131;
    likes.m1 = 44;
    await collectInstagramMetrics(o.ctx, 'manual');
    expect(await o.db.select().from(instagramSnapshots)).toHaveLength(2);
    const media = await o.db.select().from(instagramMedia);
    expect(media).toHaveLength(3);
    expect(media.find((m) => m.mediaId === 'm1')!.likeCount).toBe(44);
  });

  it('key tanpa izin insights: postingan tetap diambil, status menandai izin yang kurang (bukan error)', async () => {
    const o = await office();
    summaryScope = false;
    const st = await collectInstagramMetrics(o.ctx, 'manual');
    expect(st.accounts[0]).toMatchObject({ summary: 'no_scope', media: 'ok', posts: 3 });
    expect(st.accounts[0]!.error).toBeUndefined();
    expect(await o.db.select().from(instagramSnapshots)).toHaveLength(0);
    expect(await o.db.select().from(instagramMedia)).toHaveLength(3);
  });

  it('key tanpa izin komentar: snapshot tetap diambil; gangguan NC-WA dicatat sebagai error per akun', async () => {
    const o = await office();
    mediaScope = false;
    expect((await collectInstagramMetrics(o.ctx, 'manual')).accounts[0]).toMatchObject({ summary: 'ok', media: 'no_scope' });
    failAll = true;
    const st = await collectInstagramMetrics(o.ctx, 'manual');
    expect(st.accounts[0]).toMatchObject({ summary: 'error', media: 'error' });
    expect(st.accounts[0]!.error).toContain('Meta menolak');
  });

  it('tanpa key, atau akun kedaluwarsa: dilaporkan jelas, tidak ada data palsu', async () => {
    const none = await office(false);
    expect((await collectInstagramMetrics(none.ctx, 'manual')).error).toContain('belum dipasang');
    await cleanup?.();
    const o = await office();
    accountStatus = 'expired';
    const st = await collectInstagramMetrics(o.ctx, 'manual');
    expect(st.accounts[0]!.error).toContain('expired');
    expect(await o.db.select().from(instagramSnapshots)).toHaveLength(0);
  });

  it('pengambilan bersamaan berbagi satu hasil; pembaruan manual beruntun ditahan', async () => {
    const o = await office();
    const [a, b] = await Promise.all([collectInstagramMetrics(o.ctx, 'manual'), collectInstagramMetrics(o.ctx, 'manual')]);
    expect(a).toBe(b);
    expect(hits.filter((h) => h.endsWith('/summary'))).toHaveLength(1);
    const again = await refreshInstagramMetrics(o.ctx); // baru saja diambil
    expect(again.at).toBe(a.at);
    expect(hits.filter((h) => h.endsWith('/summary'))).toHaveLength(1);
  });

  it('terjadwal: mengikuti interval Owner, mati bila 0, diam tanpa key', async () => {
    const o = await office();
    await setSetting(o.db, 'metrics_interval_hours', 0);
    expect(await collectDueMetrics(o.ctx)).toBeNull();

    await setSetting(o.db, 'metrics_interval_hours', 6);
    const first = await collectDueMetrics(o.ctx);
    expect(first?.trigger).toBe('auto');
    expect(await collectDueMetrics(o.ctx, Date.now() + 5 * HOUR)).toBeNull(); // belum sampai 6 jam
    expect((await collectDueMetrics(o.ctx, Date.now() + 7 * HOUR))?.trigger).toBe('auto');
    expect(await o.db.select().from(instagramSnapshots)).toHaveLength(2);

    await cleanup?.();
    const nokey = await office(false);
    expect(await collectDueMetrics(nokey.ctx)).toBeNull();
  });
});

describe('Tampilan pertumbuhan', () => {
  it('selisih follower 24 jam / 7 / 30 hari dari snapshot; null bila riwayat belum cukup', async () => {
    const o = await office();
    await snap(o, 40 * DAY, 100, 200);
    await snap(o, 8 * DAY, 112, 260);
    await snap(o, 2 * DAY, 118, 300);
    await snap(o, 30 * HOUR, 121, 320);
    await snap(o, 0, 130, 400);
    const v = await growthView(o.ctx, { days: 30 });
    expect(v.latest?.followers).toBe(130);
    // 24 jam: vs 30 jam lalu (121); 7 hari: vs 8 hari lalu (112); 30 hari: vs 40 hari lalu (100)
    expect(v.deltas).toEqual({ d1: 9, d7: 18, d30: 30 });
    expect(v.historyDays).toBe(40);
    expect(v.series.map((p) => p.followers)).toEqual([112, 118, 121, 130]); // jendela 30 hari
    expect((await growthView(o.ctx, { days: 90 })).series).toHaveLength(5);

    await cleanup?.();
    const fresh = await office();
    await snap(fresh, 3 * HOUR, 100);
    await snap(fresh, 0, 105);
    expect((await growthView(fresh.ctx, { days: 30 })).deltas).toEqual({ d1: null, d7: null, d30: null });
  });

  it('pembanding yang terlalu tua tidak dipakai: tidak ada "24 jam" yang sebenarnya berhari-hari', async () => {
    const o = await office();
    await snap(o, 8 * DAY, 100);
    await snap(o, 0, 130);
    // Satu-satunya pembanding berumur 8 hari: cocok untuk 7 hari, bukan untuk 24 jam atau 30 hari.
    expect((await growthView(o.ctx, { days: 30 })).deltas).toEqual({ d1: null, d7: 30, d30: null });
  });

  it('postingan: engagement, penanda "dari sistem", dan rata-rata perbandingan', async () => {
    const o = await office();
    await collectInstagramMetrics(o.ctx, 'manual');
    await o.db.insert(toolExecutions).values({ id: randomUUID(), toolId: 'instagram_publish', args: {}, status: 'executed', result: { mediaId: 'm2' }, finishedAt: new Date() });
    // Eksekusi yang gagal atau menunggu tidak dihitung sebagai post sistem.
    await o.db.insert(toolExecutions).values({ id: randomUUID(), toolId: 'instagram_publish', args: {}, status: 'failed', result: { mediaId: 'm3' }, finishedAt: new Date() });

    const v = await growthView(o.ctx, { days: 30 });
    expect(v.posts.map((p) => p.id)).toEqual(['m1', 'm2', 'm3']); // terbaru dulu
    expect(v.posts.find((p) => p.id === 'm2')).toMatchObject({ likes: 30, comments: 1, engagement: 31, bySystem: true });
    expect(v.posts.find((p) => p.id === 'm3')!.bySystem).toBe(false);
    expect(v.postStats).toEqual({ count: 3, system: { count: 1, avgEngagement: 31 }, other: { count: 2, avgEngagement: 8.5 } });
  });

  it('tanpa data: kosong tapi tidak error; akun dipilih dari data yang ada', async () => {
    const o = await office(false);
    const v = await growthView(o.ctx, { days: 30 });
    expect(v).toMatchObject({ configured: false, accounts: [], accountId: null, latest: null, series: [], posts: [] });
    await snap(o, 0, 50);
    expect((await growthView(o.ctx, { days: 30, accountId: 'tidak-ada' })).accountId).toBe(ACC);
  });
});

describe('Masukan untuk CEO', () => {
  const base = { brief: { name: 'Kopi', businessType: 'kafe', product: 'kopi', audience: '', guidelines: '', forbidden: '' }, maxNew: 2, plannable: [], open: [], recent: [], budget: { monthlyUsd: 0, spentUsd: 0 } };

  it('ringkasan memuat follower, selisih, jangkauan, dan post terbaik; kosong bila belum ada data', async () => {
    const o = await office();
    expect(await growthBrief(o.ctx)).toBe('');
    await snap(o, 8 * DAY, 100, 300);
    await collectInstagramMetrics(o.ctx, 'manual'); // followers 120, reach 400, interaksi 80
    const brief = await growthBrief(o.ctx);
    expect(brief).toContain('@kopisenja: 120 follower');
    expect(brief).toContain('7 hari +20');
    expect(brief).toContain('24 jam belum ada data');
    expect(brief).toContain('jangkauan 30 hari 400');
    expect(brief).toContain('20.0% dari jangkauan');
    expect(brief).toContain('Post terbaik: "Promo akhir pekan" (30 suka, 1 komentar)');
  });

  it('prompt agenda hanya memuat bagian pertumbuhan bila ada data', () => {
    expect(agendaInstructions(base)).not.toContain('Data pertumbuhan');
    const withData = agendaInstructions({ ...base, growth: '- @kopisenja: 120 follower' });
    expect(withData).toContain('## Data pertumbuhan akun');
    expect(withData).toContain('@kopisenja: 120 follower');
    expect(withData).toContain('mengembangkan akun');
  });
});

describe('API pertumbuhan', () => {
  it('GET /api/growth dan POST /api/growth/refresh; interval bisa diatur lewat pengaturan', async () => {
    const o = await office();
    const app = buildServer(o.ctx, o.worker);
    cleanup = async () => (await app.close(), await o.worker.stop(), await o.close());
    const local = { host: 'localhost:8070' };

    expect((await app.inject({ method: 'GET', url: '/api/growth', headers: local })).json()).toMatchObject({ configured: true, accounts: [], latest: null });
    const refreshed = await app.inject({ method: 'POST', url: '/api/growth/refresh', headers: local });
    expect(refreshed.json().accounts[0]).toMatchObject({ summary: 'ok', media: 'ok', posts: 3 });
    const view = (await app.inject({ method: 'GET', url: `/api/growth?account=${ACC}&days=7`, headers: local })).json();
    expect(view).toMatchObject({ accountId: ACC, latest: { followers: 120 }, intervalHours: 6 });
    expect(view.posts).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: '/api/growth?days=0', headers: local })).statusCode).toBe(400);

    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/settings', headers: local, payload });
    expect((await put({ metrics_interval_hours: 12 })).json().metrics_interval_hours).toBe(12);
    expect((await put({ metrics_interval_hours: -1 })).statusCode).toBe(400);
    expect((await put({ metrics_interval_hours: 999 })).statusCode).toBe(400);
  });
});
