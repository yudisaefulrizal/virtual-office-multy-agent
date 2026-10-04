import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { toolCredentials } from '../db/schema';
import { UserError } from '../domain';
import { type OfficeContext, withTx } from './context';

/**
 * Instagram lewat NC-WA (ncwa.nuscode.id): akun resmi sudah terhubung di sana, jadi aplikasi ini tidak login ke
 * Meta sendiri. Owner cukup memasukkan satu API key (ncig_…) yang disimpan terenkripsi.
 */
const KEY_TOOL_ID = 'ncwa_instagram';
const PUBLISH_PERMISSION = 'instagram_business_content_publish';

// Alamat bisa diganti lewat env hanya agar tes memakai server tiruan.
const baseUrl = () => (process.env.NCWA_INSTAGRAM_URL ?? 'https://ncwa.nuscode.id/api/v1/instagram').replace(/\/+$/, '');
const timeout = () => AbortSignal.timeout(20_000);

export async function storedKey(ctx: OfficeContext) {
  const [row] = await ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, KEY_TOOL_ID));
  return row ? { key: ctx.secrets.decrypt(row.secretEnc), last4: row.secretLast4 } : null;
}

/** Kesalahan dari NC-WA dengan kode HTTP, agar pemanggil bisa membedakan izin (403) dari gangguan lain. */
export class NcwaError extends UserError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function ncwa<T>(key: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeout(),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) {
    if (res.status === 401) throw new NcwaError('API key NC-WA tidak valid', 401);
    if (res.status === 403) throw new NcwaError('API key NC-WA belum punya izin (scope) yang diperlukan', 403);
    if (res.status === 429) throw new NcwaError('Terlalu banyak permintaan ke NC-WA; coba lagi sebentar lagi', 429);
    throw new NcwaError(`NC-WA: ${json.message ?? json.error ?? `HTTP ${res.status}`}`, res.status);
  }
  return json as T;
}

export interface NcwaAccount {
  id: string;
  username: string;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  permissions?: string[];
  daysLeft?: number;
}

export const listAccounts = (key: string) => ncwa<NcwaAccount[]>(key, 'GET', '/accounts');

export async function setInstagramKey(ctx: OfficeContext, input: { apiKey: string }) {
  // Toleran pada teks tempelan seperti `NCWA_apikey=ncig_…`, tanda kutip, atau `Bearer ncig_…`.
  const apiKey = input.apiKey.match(/ncig_[0-9a-f]{64}/)?.[0];
  if (!apiKey) throw new UserError('API key NC-WA berbentuk ncig_ diikuti 64 karakter (salin utuh dari Dashboard NC-WA › Integrasi)');
  await listAccounts(apiKey); // menolak key yang salah sebelum disimpan
  await withTx(ctx, async (tx, emit) => {
    const row = { secretEnc: ctx.secrets.encrypt(apiKey), secretLast4: apiKey.slice(-4), config: {}, updatedAt: new Date() };
    await tx.insert(toolCredentials).values({ toolId: KEY_TOOL_ID, ...row }).onDuplicateKeyUpdate({ set: row });
    emit({ type: 'instagram.key_set', entityType: 'tool', entityId: KEY_TOOL_ID, actor: 'owner' });
  });
}

export async function removeInstagramKey(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    await tx.delete(toolCredentials).where(eq(toolCredentials.toolId, KEY_TOOL_ID));
    emit({ type: 'instagram.key_removed', entityType: 'tool', entityId: KEY_TOOL_ID, actor: 'owner' });
  });
}

export type InstagramStatus = NcwaAccount['status'];

export async function instagramOverview(ctx: OfficeContext) {
  const stored = await storedKey(ctx);
  let accounts: { id: string; username: string; status: InstagramStatus; daysLeft: number; canPublish: boolean }[] = [];
  let error: string | null = null;
  if (stored) {
    try {
      accounts = (await listAccounts(stored.key)).map((a) => ({
        id: a.id,
        username: a.username,
        status: a.status,
        daysLeft: a.daysLeft ?? 0,
        canPublish: (a.permissions ?? []).includes(PUBLISH_PERMISSION),
      }));
    } catch (err) {
      error = err instanceof Error ? err.message : 'NC-WA tidak bisa dihubungi';
    }
  }
  return { configured: !!stored, last4: stored?.last4 ?? null, accounts, error };
}

/** Akun yang boleh dipakai menerbitkan (aktif, punya izin posting). */
export async function publishableAccount(ctx: OfficeContext, username?: string) {
  const stored = await storedKey(ctx);
  if (!stored) return undefined;
  const accounts = await listAccounts(stored.key).catch(() => [] as NcwaAccount[]);
  const account = accounts.find((a) => (!username || a.username === username) && (a.status === 'active' || a.status === 'expiring') && (a.permissions ?? []).includes(PUBLISH_PERMISSION));
  return account ? { ...account, key: stored.key } : undefined;
}

interface NcwaPost {
  status: 'preparing' | 'processing' | 'publishing' | 'published' | 'failed' | 'unknown';
  mediaId?: string | null;
}

/**
 * Terbitkan satu gambar ke feed lewat NC-WA. requestId unik mencegah posting ganda; status dipantau sampai
 * published. Dipanggil sistem setelah disetujui (atau diizinkan otomatis), bukan oleh agent.
 */
export async function publishInstagramImage(ctx: OfficeContext, input: { imageUrl: string; caption: string; username?: string }, opts: { pollMs?: number; maxPolls?: number } = {}) {
  const account = await publishableAccount(ctx, input.username);
  if (!account) throw new UserError('Belum ada akun Instagram yang terhubung dengan izin posting. Isi API key NC-WA di halaman Akses.');
  const requestId = randomUUID();
  let post = await ncwa<NcwaPost>(account.key, 'POST', '/posts', { requestId, igUserId: account.id, imageUrl: input.imageUrl, caption: input.caption });
  const pollMs = opts.pollMs ?? 2000;
  for (let i = 0; ; i++) {
    if (post.status === 'published') {
      if (!post.mediaId) throw new Error('Instagram: publikasi tidak mengembalikan ID');
      return { mediaId: post.mediaId, username: account.username };
    }
    if (post.status === 'failed') throw new Error('Instagram: postingan ditolak');
    if (post.status === 'unknown') throw new Error('Instagram: hasil publikasi belum pasti; periksa akun Instagram sebelum mengirim ulang');
    if (i >= (opts.maxPolls ?? 30)) throw new Error('Instagram: pemrosesan terlalu lama; periksa akun Instagram sebelum mengirim ulang');
    await new Promise((r) => setTimeout(r, pollMs));
    post = await ncwa<NcwaPost>(account.key, 'GET', `/posts/${requestId}`);
  }
}
