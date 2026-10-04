import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { instagramMedia, instagramSnapshots, toolExecutions } from '../db/schema';
import type { OfficeContext } from './context';
import { storedKey } from './instagram';
import type { MetricsStatus } from './metrics';
import { getSetting } from './settings';

const DAY = 24 * 3600_000;
const POST_LIMIT = 100;

export interface GrowthPoint {
  t: string;
  followers: number;
  reach: number | null;
  interactions: number | null;
}
export interface GrowthPost {
  id: string;
  caption: string | null;
  mediaType: string | null;
  permalink: string | null;
  mediaUrl: string | null;
  postedAt: string | null;
  likes: number;
  comments: number;
  engagement: number;
  /** Diterbitkan oleh sistem ini (lewat tool instagram_publish), bukan diunggah manual. */
  bySystem: boolean;
}

/** Mediaid yang diterbitkan sistem: hasil tool instagram_publish yang sudah dieksekusi. */
async function systemMediaIds(ctx: OfficeContext) {
  const rows = await ctx.db.select({ result: toolExecutions.result }).from(toolExecutions).where(and(eq(toolExecutions.toolId, 'instagram_publish'), eq(toolExecutions.status, 'executed')));
  return new Set(rows.map((r) => (r.result as { mediaId?: string } | null)?.mediaId).filter((x): x is string => !!x));
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export async function growthView(ctx: OfficeContext, input: { accountId?: string; days: number }) {
  const [intervalHours, status, stored] = await Promise.all([getSetting(ctx.db, 'metrics_interval_hours'), getSetting(ctx.db, 'metrics_status'), storedKey(ctx)]);

  // Akun diambil dari data yang pernah terkumpul, jadi tetap terlihat walau key sedang bermasalah.
  const known = new Map<string, string>();
  for (const s of await ctx.db.select({ id: instagramSnapshots.accountId, u: instagramSnapshots.username }).from(instagramSnapshots).orderBy(asc(instagramSnapshots.fetchedAt))) known.set(s.id, s.u);
  for (const m of await ctx.db.selectDistinct({ id: instagramMedia.accountId }).from(instagramMedia)) if (!known.has(m.id)) known.set(m.id, status?.accounts.find((a) => a.id === m.id)?.username ?? m.id);
  const accounts = [...known].map(([id, username]) => ({ id, username }));
  const accountId = input.accountId && known.has(input.accountId) ? input.accountId : accounts[0]?.id ?? null;

  const base = { configured: !!stored, intervalHours, status: status as MetricsStatus | null, accounts, accountId };
  if (!accountId) return { ...base, latest: null, deltas: { d1: null, d7: null, d30: null }, historyDays: 0, series: [] as GrowthPoint[], posts: [] as GrowthPost[], postStats: null };

  const all = await ctx.db.select().from(instagramSnapshots).where(eq(instagramSnapshots.accountId, accountId)).orderBy(asc(instagramSnapshots.fetchedAt));
  const latest = all.at(-1) ?? null;
  // Selisih hanya bermakna bila pembandingnya benar-benar dari sekitar periodenya. Snapshot yang jauh lebih tua
  // (pengumpul sempat mati) akan menghasilkan angka berlabel "24 jam" yang sebenarnya berhari-hari: lebih baik kosong.
  const delta = (ms: number) => {
    if (!latest) return null;
    const target = latest.fetchedAt.getTime() - ms;
    const tolerance = Math.max(ms * 0.5, 12 * 3600_000);
    const before = [...all].reverse().find((s) => s.fetchedAt.getTime() <= target);
    return before && target - before.fetchedAt.getTime() <= tolerance ? latest.followers - before.followers : null;
  };
  const since = Date.now() - input.days * DAY;
  const series: GrowthPoint[] = all.filter((s) => s.fetchedAt.getTime() >= since).map((s) => ({ t: s.fetchedAt.toISOString(), followers: s.followers, reach: s.reach, interactions: s.totalInteractions }));

  const system = await systemMediaIds(ctx);
  const rows = await ctx.db.select().from(instagramMedia).where(eq(instagramMedia.accountId, accountId)).orderBy(desc(instagramMedia.postedAt)).limit(POST_LIMIT);
  const posts: GrowthPost[] = rows.map((m) => ({
    id: m.mediaId,
    caption: m.caption,
    mediaType: m.mediaType,
    permalink: m.permalink,
    mediaUrl: m.mediaUrl,
    postedAt: m.postedAt?.toISOString() ?? null,
    likes: m.likeCount ?? 0,
    comments: m.commentsCount ?? 0,
    engagement: (m.likeCount ?? 0) + (m.commentsCount ?? 0),
    bySystem: system.has(m.mediaId),
  }));
  const sys = posts.filter((p) => p.bySystem).map((p) => p.engagement);
  const other = posts.filter((p) => !p.bySystem).map((p) => p.engagement);

  return {
    ...base,
    latest: latest && { ...latest, fetchedAt: latest.fetchedAt.toISOString() },
    deltas: { d1: delta(DAY), d7: delta(7 * DAY), d30: delta(30 * DAY) },
    historyDays: all[0] && latest ? Math.floor((latest.fetchedAt.getTime() - all[0].fetchedAt.getTime()) / DAY) : 0,
    series,
    posts,
    postStats: { count: posts.length, system: { count: sys.length, avgEngagement: avg(sys) }, other: { count: other.length, avgEngagement: avg(other) } },
  };
}

const sign = (n: number | null) => (n === null ? 'belum ada data' : `${n > 0 ? '+' : ''}${n}`);
const clip = (s: string | null, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Ringkasan pertumbuhan akun untuk prompt CEO saat menyusun agenda. Kosong bila belum ada data, agar agenda
 * tidak dibangun di atas angka yang tidak ada.
 */
export async function growthBrief(ctx: OfficeContext) {
  const lines: string[] = [];
  const { accounts } = await growthView(ctx, { days: 30 }).then((v) => ({ accounts: v.accounts }));
  for (const acc of accounts.slice(0, 3)) {
    const v = await growthView(ctx, { accountId: acc.id, days: 30 });
    if (!v.latest && v.posts.length === 0) continue;
    const parts = [`@${acc.username}:`];
    if (v.latest) {
      const rate = v.latest.reach && v.latest.totalInteractions != null ? ` interaksi ${v.latest.totalInteractions} (${((v.latest.totalInteractions / v.latest.reach) * 100).toFixed(1)}% dari jangkauan)` : '';
      parts.push(`${v.latest.followers} follower (24 jam ${sign(v.deltas.d1)}, 7 hari ${sign(v.deltas.d7)}, 30 hari ${sign(v.deltas.d30)}); jangkauan 30 hari ${v.latest.reach ?? 'tidak tersedia'};${rate}`.replace(/;$/, ''));
    } else {
      parts.push('jumlah follower belum tersedia (key NC-WA belum punya izin insights).');
    }
    lines.push(`- ${parts.join(' ')}`);
    const top = [...v.posts].sort((a, b) => b.engagement - a.engagement).slice(0, 3);
    if (top.length) lines.push(`  Post terbaik: ${top.map((p) => `"${clip(p.caption, 60)}" (${p.likes} suka, ${p.comments} komentar)`).join('; ')}`);
    const s = v.postStats;
    if (s && s.system.count > 0) lines.push(`  Post dari sistem ini: ${s.system.count} (rata-rata interaksi ${s.system.avgEngagement}) dibanding lainnya ${s.other.count} (${s.other.avgEngagement ?? '-'}).`);
  }
  return lines.join('\n').slice(0, 1500);
}
