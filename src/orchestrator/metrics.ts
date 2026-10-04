import { randomUUID } from 'node:crypto';
import { instagramMedia, instagramSnapshots } from '../db/schema';
import { type OfficeContext, withTx } from './context';
import { NcwaError, listAccounts, ncwa, storedKey } from './instagram';
import { getSetting, setSetting } from './settings';

/**
 * Pengumpul data akun Instagram lewat NC-WA. /summary hanya memberi kondisi saat ini, jadi tiap pengambilan
 * disimpan sebagai snapshot dan pertumbuhan dihitung dari selisih snapshot. Postingan (like, komentar)
 * diperbarui di tempat. Kedua sumber punya izin (scope) berbeda, jadi kegagalan satu tidak menghentikan yang lain.
 */
export type SourceState = 'ok' | 'no_scope' | 'error';
export interface MetricsStatus {
  at: string;
  trigger: 'auto' | 'manual';
  /** Gangguan di luar akun tertentu (key belum dipasang, NC-WA tidak terjangkau). */
  error?: string;
  accounts: { id: string; username: string; summary: SourceState; media: SourceState; posts: number; error?: string }[];
}

interface NcwaSummary {
  followers?: number;
  following?: number | null;
  mediaCount?: number | null;
  month?: Record<string, number | null | string | string[]>;
}
interface NcwaMedia {
  id: string;
  caption?: string | null;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number | null;
  comments_count?: number | null;
}

const MAX_MEDIA_PAGES = 3;
const MANUAL_MIN_GAP_MS = 30_000;
const inflight = new WeakMap<OfficeContext, Promise<MetricsStatus>>();

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
/** Instagram menulis zona waktu +0000; bentuk tanpa titik dua tidak dijamin terbaca di semua mesin. */
const parseTime = (s?: string) => {
  const t = s ? Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : NaN;
  return Number.isNaN(t) ? null : new Date(t);
};
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function collectAccount(ctx: OfficeContext, key: string, acc: { id: string; username: string }) {
  const out: MetricsStatus['accounts'][number] = { id: acc.id, username: acc.username, summary: 'ok', media: 'ok', posts: 0 };
  const note = (e: unknown) => (out.error = out.error ? `${out.error}; ${message(e)}` : message(e));

  try {
    const s = await ncwa<NcwaSummary>(key, 'GET', `/accounts/${acc.id}/summary`);
    const m = s.month ?? {};
    if (num(s.followers) === null) throw new Error('NC-WA tidak mengembalikan jumlah follower');
    await ctx.db.insert(instagramSnapshots).values({
      id: randomUUID(),
      accountId: acc.id,
      username: acc.username,
      followers: num(s.followers)!,
      following: num(s.following),
      mediaCount: num(s.mediaCount),
      views: num(m.views),
      reach: num(m.reach),
      accountsEngaged: num(m.accounts_engaged),
      totalInteractions: num(m.total_interactions),
      likes: num(m.likes),
      comments: num(m.comments),
      shares: num(m.shares),
      saves: num(m.saves),
      profileViews: num(m.profile_views),
    });
  } catch (err) {
    out.summary = err instanceof NcwaError && err.status === 403 ? 'no_scope' : 'error';
    if (out.summary === 'error') note(err);
  }

  try {
    let after: string | null = null;
    for (let page = 0; page < MAX_MEDIA_PAGES; page++) {
      const res: { data?: NcwaMedia[]; next?: string | null } = await ncwa(key, 'GET', `/accounts/${acc.id}/media?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      const now = new Date();
      for (const m of res.data ?? []) {
        if (!m.id) continue;
        const row = {
          caption: m.caption ?? null,
          mediaType: m.media_type ?? null,
          permalink: m.permalink ?? null,
          mediaUrl: m.media_url ?? null,
          postedAt: parseTime(m.timestamp),
          likeCount: num(m.like_count),
          commentsCount: num(m.comments_count),
          fetchedAt: now,
        };
        await ctx.db.insert(instagramMedia).values({ accountId: acc.id, mediaId: m.id, ...row }).onDuplicateKeyUpdate({ set: row });
        out.posts++;
      }
      after = res.next ?? null;
      if (!after) break;
    }
  } catch (err) {
    out.media = err instanceof NcwaError && err.status === 403 ? 'no_scope' : 'error';
    if (out.media === 'error') note(err);
  }
  return out;
}

async function save(ctx: OfficeContext, status: MetricsStatus) {
  await withTx(ctx, async (tx, emit) => {
    await setSetting(tx, 'metrics_status', status);
    emit({
      type: 'metrics.collected',
      entityType: 'metrics',
      entityId: 'instagram',
      actor: 'orchestrator',
      payload: { trigger: status.trigger, error: status.error, accounts: status.accounts.map((a) => ({ username: a.username, summary: a.summary, media: a.media, posts: a.posts })) },
    });
  });
  return status;
}

/** Ambil data semua akun yang terhubung. Satu pengambilan pada satu waktu; pemanggilan bersamaan berbagi hasilnya. */
export function collectInstagramMetrics(ctx: OfficeContext, trigger: 'auto' | 'manual'): Promise<MetricsStatus> {
  const running = inflight.get(ctx);
  if (running) return running;
  const job = (async () => {
    const at = new Date().toISOString();
    const stored = await storedKey(ctx);
    if (!stored) return save(ctx, { at, trigger, accounts: [], error: 'API key NC-WA belum dipasang (halaman Akses)' });
    let accounts;
    try {
      accounts = await listAccounts(stored.key);
    } catch (err) {
      return save(ctx, { at, trigger, accounts: [], error: message(err) });
    }
    const out: MetricsStatus['accounts'] = [];
    for (const acc of accounts) {
      if (acc.status !== 'active' && acc.status !== 'expiring') {
        out.push({ id: acc.id, username: acc.username, summary: 'error', media: 'error', posts: 0, error: `Akun ${acc.status}; hubungkan ulang di NC-WA` });
        continue;
      }
      out.push(await collectAccount(ctx, stored.key, acc));
    }
    return save(ctx, { at, trigger, accounts: out });
  })().finally(() => inflight.delete(ctx));
  inflight.set(ctx, job);
  return job;
}

/** Pembaruan manual dari halaman Pertumbuhan; ditolak halus bila baru saja diambil agar tidak menumpuk permintaan. */
export async function refreshInstagramMetrics(ctx: OfficeContext) {
  const last = await getSetting(ctx.db, 'metrics_status');
  if (last && Date.now() - Date.parse(last.at) < MANUAL_MIN_GAP_MS && !inflight.has(ctx)) return last;
  return collectInstagramMetrics(ctx, 'manual');
}

/** Dipanggil worker secara berkala: ambil data bila sudah lewat interval yang diatur Owner. */
export async function collectDueMetrics(ctx: OfficeContext, now = Date.now()) {
  const hours = await getSetting(ctx.db, 'metrics_interval_hours');
  if (hours <= 0) return null;
  if (!(await storedKey(ctx))) return null;
  const last = await getSetting(ctx.db, 'metrics_status');
  if (last && now - Date.parse(last.at) < hours * 3600_000) return null;
  return collectInstagramMetrics(ctx, 'auto');
}
