import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { instagramAccounts, instagramStates, toolCredentials } from '../db/schema';
import { UserError } from '../domain';
import { type OfficeContext, withTx } from './context';

/**
 * Instagram Login resmi (Business Login for Instagram), sama seperti nc-wa-official: Owner memberi izin
 * langsung di instagram.com, kode ditukar menjadi token 60 hari yang disimpan terenkripsi dan diperpanjang
 * otomatis. Tidak ada password atau token yang diketik manual. Satu pemilik, jadi tidak ada pemisahan akun.
 */
const APP_TOOL_ID = 'instagram_login_app';
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_WITHIN_DAYS = 14;

// Alamat Meta bisa diganti lewat env hanya agar tes memakai server tiruan.
const urls = () => ({
  authorize: process.env.INSTAGRAM_AUTHORIZE_URL ?? 'https://www.instagram.com/oauth/authorize',
  token: process.env.INSTAGRAM_TOKEN_URL ?? 'https://api.instagram.com/oauth/access_token',
  graph: process.env.INSTAGRAM_GRAPH_URL ?? 'https://graph.instagram.com',
});
const timeout = () => AbortSignal.timeout(15_000);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const redirectUri = (ctx: OfficeContext) => `${ctx.appOrigin ?? 'http://localhost:8070'}/auth/instagram/callback`;

async function appCredentials(ctx: OfficeContext) {
  const [row] = await ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, APP_TOOL_ID));
  if (!row) throw new UserError('Isi App ID dan App Secret Instagram dulu di halaman Akses');
  return { id: String((row.config as { app_id?: string }).app_id ?? ''), secret: ctx.secrets.decrypt(row.secretEnc), last4: row.secretLast4 };
}

export async function setInstagramApp(ctx: OfficeContext, input: { appId: string; appSecret?: string }) {
  const appId = input.appId.trim();
  if (!/^\d{5,32}$/.test(appId)) throw new UserError('App ID Instagram berupa angka');
  const [existing] = await ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, APP_TOOL_ID));
  const secret = input.appSecret?.trim() || (existing ? ctx.secrets.decrypt(existing.secretEnc) : '');
  if (!secret) throw new UserError('App Secret wajib diisi');
  await withTx(ctx, async (tx, emit) => {
    const row = { secretEnc: ctx.secrets.encrypt(secret), secretLast4: secret.slice(-4), config: { app_id: appId }, updatedAt: new Date() };
    await tx.insert(toolCredentials).values({ toolId: APP_TOOL_ID, ...row }).onDuplicateKeyUpdate({ set: row });
    emit({ type: 'instagram.app_set', entityType: 'tool', entityId: APP_TOOL_ID, actor: 'owner' });
  });
}

export async function removeInstagramApp(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    await tx.delete(toolCredentials).where(eq(toolCredentials.toolId, APP_TOOL_ID));
    emit({ type: 'instagram.app_removed', entityType: 'tool', entityId: APP_TOOL_ID, actor: 'owner' });
  });
}

/** Alamat izin di instagram.com dengan state sekali pakai. */
export async function startInstagramLogin(ctx: OfficeContext) {
  const app = await appCredentials(ctx);
  const state = randomBytes(24).toString('hex');
  await ctx.db.delete(instagramStates).where(lt(instagramStates.createdAt, new Date(Date.now() - STATE_TTL_MS)));
  await ctx.db.insert(instagramStates).values({ stateHash: sha(state) });
  const url = new URL(urls().authorize);
  url.searchParams.set('client_id', app.id);
  url.searchParams.set('redirect_uri', redirectUri(ctx));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('state', state);
  return { url: url.toString() };
}

async function meta(response: Response, what: string) {
  if (!response.ok) {
    // Isi respons Meta tidak dicatat: bisa memuat token atau data akun.
    console.error(`[instagram] ${what} ditolak Meta (${response.status})`);
    throw new UserError('Instagram menolak permintaan; coba hubungkan lagi');
  }
  return (await response.json()) as Record<string, unknown>;
}

async function consumeState(ctx: OfficeContext, state: string) {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(instagramStates).where(eq(instagramStates.stateHash, sha(state))).for('update');
    if (!row) return false;
    await tx.delete(instagramStates).where(eq(instagramStates.stateHash, sha(state)));
    return Date.now() - row.createdAt.getTime() <= STATE_TTL_MS;
  });
}

/** Callback dari Instagram. result: connected | cancelled | error. */
export async function finishInstagramLogin(ctx: OfficeContext, query: Record<string, unknown>): Promise<{ result: 'connected' | 'cancelled' | 'error'; username?: string }> {
  const state = typeof query.state === 'string' ? query.state : '';
  if (!state || !(await consumeState(ctx, state))) return { result: 'error' };
  if (typeof query.error === 'string') return { result: 'cancelled' };
  if (typeof query.code !== 'string' || !query.code) return { result: 'error' };
  const app = await appCredentials(ctx);

  const short = await meta(
    await fetch(urls().token, {
      method: 'POST',
      body: new URLSearchParams({ client_id: app.id, client_secret: app.secret, grant_type: 'authorization_code', redirect_uri: redirectUri(ctx), code: query.code.replace(/#_$/, '') }),
      signal: timeout(),
    }),
    'Tukar kode',
  );
  const long = await meta(
    await fetch(`${urls().graph}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.secret, access_token: String(short.access_token) })}`, { signal: timeout() }),
    'Tukar token panjang',
  );
  const token = String(long.access_token);
  const lifetime = Number(long.expires_in) || 5_184_000;
  const profile = await meta(
    await fetch(`${urls().graph}/me?${new URLSearchParams({ fields: 'user_id,username,account_type', access_token: token })}`, { signal: timeout() }),
    'Baca profil',
  );
  const igUser = String(profile.user_id ?? short.user_id ?? '');
  if (!/^[0-9]{3,32}$/.test(igUser)) throw new UserError('Profil Instagram tidak terbaca');
  const username = String(profile.username ?? '').slice(0, 100);
  const permissions = (Array.isArray(short.permissions) ? short.permissions.join(',') : String(short.permissions ?? '')).slice(0, 500);

  await withTx(ctx, async (tx, emit) => {
    const values = {
      username,
      accountType: String(profile.account_type ?? '').slice(0, 30),
      tokenEnc: ctx.secrets.encrypt(token),
      permissions,
      status: 'active',
      expiresAt: new Date(Date.now() + lifetime * 1000),
      updatedAt: new Date(),
    };
    await tx.insert(instagramAccounts).values({ igUserId: igUser, ...values }).onDuplicateKeyUpdate({ set: values });
    emit({ type: 'instagram.connected', entityType: 'tool', entityId: igUser, actor: 'owner', payload: { username } });
  });
  return { result: 'connected', username };
}

export type InstagramStatus = 'active' | 'expiring' | 'expired' | 'revoked';

export async function instagramOverview(ctx: OfficeContext) {
  let app: { id: string; last4: string } | null = null;
  try {
    const a = await appCredentials(ctx);
    app = { id: a.id, last4: a.last4 };
  } catch {
    app = null;
  }
  const rows = await ctx.db.select().from(instagramAccounts).orderBy(asc(instagramAccounts.createdAt));
  return {
    app: { configured: !!app, appId: app?.id ?? '', secretLast4: app?.last4 ?? null, redirectUri: redirectUri(ctx) },
    publishScope: SCOPES[1],
    accounts: rows.map((r) => {
      const left = Math.ceil((r.expiresAt.getTime() - Date.now()) / 86_400_000);
      const status: InstagramStatus = r.status === 'revoked' ? 'revoked' : left <= 0 ? 'expired' : left <= 7 ? 'expiring' : 'active';
      return { id: r.igUserId, username: r.username, accountType: r.accountType, status, daysLeft: Math.max(left, 0), canPublish: r.permissions.split(',').includes('instagram_business_content_publish') };
    }),
  };
}

export async function disconnectInstagram(ctx: OfficeContext, igUserId: string) {
  await withTx(ctx, async (tx, emit) => {
    const [row] = await tx.select().from(instagramAccounts).where(eq(instagramAccounts.igUserId, igUserId));
    if (!row) throw new UserError('Akun Instagram tidak ditemukan');
    await tx.delete(instagramAccounts).where(eq(instagramAccounts.igUserId, igUserId));
    emit({ type: 'instagram.disconnected', entityType: 'tool', entityId: igUserId, actor: 'owner', payload: { username: row.username } });
  });
}

async function refreshOne(ctx: OfficeContext, igUserId: string) {
  const [row] = await ctx.db.select().from(instagramAccounts).where(eq(instagramAccounts.igUserId, igUserId));
  if (!row) throw new UserError('Akun Instagram tidak ditemukan');
  if (row.status === 'revoked' || row.expiresAt.getTime() <= Date.now()) throw new UserError('Izin sudah berakhir; hubungkan Instagram lagi');
  const data = await meta(
    await fetch(`${urls().graph}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: ctx.secrets.decrypt(row.tokenEnc) })}`, { signal: timeout() }),
    'Perpanjang token',
  );
  const lifetime = Number(data.expires_in) || 5_184_000;
  await ctx.db.update(instagramAccounts).set({ tokenEnc: ctx.secrets.encrypt(String(data.access_token)), expiresAt: new Date(Date.now() + lifetime * 1000), updatedAt: new Date() }).where(eq(instagramAccounts.igUserId, igUserId));
}

export const refreshInstagram = refreshOne;

/** Dipanggil berkala: memperpanjang token yang hampir habis. Kegagalan satu akun tidak menghentikan yang lain. */
export async function refreshExpiringInstagram(ctx: OfficeContext) {
  const soon = new Date(Date.now() + REFRESH_WITHIN_DAYS * 86_400_000);
  const rows = await ctx.db.select().from(instagramAccounts).where(and(eq(instagramAccounts.status, 'active'), lt(instagramAccounts.expiresAt, soon), sql`${instagramAccounts.expiresAt} > NOW(3)`));
  for (const r of rows) await refreshOne(ctx, r.igUserId).catch(() => console.error(`[instagram] perpanjangan token ${r.igUserId} gagal`));
}

/** Akun yang boleh dipakai menerbitkan (aktif, belum kedaluwarsa, punya izin posting). */
export async function publishableAccount(ctx: OfficeContext, username?: string) {
  const rows = await ctx.db.select().from(instagramAccounts).orderBy(asc(instagramAccounts.createdAt));
  return rows.find((r) => (!username || r.username === username) && r.status === 'active' && r.expiresAt.getTime() > Date.now() && r.permissions.split(',').includes('instagram_business_content_publish'));
}

async function graphCall(ctx: OfficeContext, path: string, token: string, body?: Record<string, string>) {
  const res = await fetch(`${urls().graph}/v23.0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}` },
    body: body ? new URLSearchParams(body) : undefined,
    signal: timeout(),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; status_code?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Instagram: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

/**
 * Terbitkan satu gambar ke feed: buat container, tunggu Meta selesai memproses, lalu media_publish.
 * Dipanggil sistem setelah disetujui (atau diizinkan otomatis), bukan oleh agent.
 */
export async function publishInstagramImage(ctx: OfficeContext, input: { imageUrl: string; caption: string; username?: string }, opts: { pollMs?: number; maxPolls?: number } = {}) {
  const account = await publishableAccount(ctx, input.username);
  if (!account) throw new UserError('Belum ada akun Instagram yang terhubung dengan izin posting. Hubungkan di halaman Akses.');
  const token = ctx.secrets.decrypt(account.tokenEnc);
  const container = await graphCall(ctx, `${account.igUserId}/media`, token, { image_url: input.imageUrl, caption: input.caption });
  if (!container.id || !/^\d+$/.test(container.id)) throw new Error('Instagram: container tidak valid');
  const pollMs = opts.pollMs ?? 2000;
  for (let i = 0; i < (opts.maxPolls ?? 30); i++) {
    const st = await graphCall(ctx, `${container.id}?fields=status_code`, token);
    if (st.status_code === 'FINISHED') {
      const published = await graphCall(ctx, `${account.igUserId}/media_publish`, token, { creation_id: container.id });
      if (!published.id) throw new Error('Instagram: publikasi tidak mengembalikan ID');
      return { mediaId: published.id, username: account.username };
    }
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram: gambar ditolak (${st.status_code})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('Instagram: pemrosesan gambar terlalu lama; coba lagi nanti');
}
