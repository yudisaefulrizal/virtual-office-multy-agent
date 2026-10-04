import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { eq, gte, sql } from 'drizzle-orm';
import satori from 'satori';
import { imageGenerations, toolCredentials } from '../db/schema';
import { UserError } from '../domain';
import { type OfficeContext, withTx } from './context';
import { getSetting } from './settings';

/**
 * Gambar untuk post. Model gambar OpenRouter dipakai bila diaktifkan Owner dan kuotanya masih ada; selain itu
 * (nonaktif, kuota habis, gagal, ukuran tidak cocok) post tetap jalan dengan teks di latar putih buatan sendiri.
 * OpenRouter di sini khusus model gambar; agent teks tetap lewat Claude CLI.
 */
const KEY_TOOL_ID = 'openrouter_image';
const WIDTH = 1080;
const HEIGHT = 1350; // 4:5, batas terjangkau feed Instagram lewat NC-WA (1:1 sampai 4:5)
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.0;

const baseUrl = () => (process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const MEDIA_FILE = /^[0-9a-f]{32}\.(png|jpg)$/;
export const isMediaFile = (name: string) => MEDIA_FILE.test(name);
export const mediaPath = (ctx: OfficeContext, file: string) => path.join(ctx.workspacesDir, 'media', file);

export interface ImageModelConfig {
  configured: boolean;
  last4: string | null;
  model: string;
  enabled: boolean;
}

async function storedRow(ctx: OfficeContext) {
  const [row] = await ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, KEY_TOOL_ID));
  return row;
}

export async function imageModelConfig(ctx: OfficeContext): Promise<ImageModelConfig> {
  const row = await storedRow(ctx);
  const cfg = (row?.config ?? {}) as { model?: string; enabled?: boolean };
  return { configured: !!row, last4: row?.secretLast4 ?? null, model: cfg.model ?? '', enabled: !!row && cfg.enabled !== false };
}

export async function setImageModel(ctx: OfficeContext, input: { apiKey?: string; model: string; enabled: boolean }) {
  const existing = await storedRow(ctx);
  const apiKey = input.apiKey?.trim() || (existing ? ctx.secrets.decrypt(existing.secretEnc) : '');
  if (!apiKey) throw new UserError('API key OpenRouter wajib diisi');
  const model = input.model.trim();
  if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new UserError('Model berbentuk vendor/model, mis. google/gemini-2.5-flash-image');
  await withTx(ctx, async (tx, emit) => {
    const row = { secretEnc: ctx.secrets.encrypt(apiKey), secretLast4: apiKey.slice(-4), config: { model, enabled: input.enabled }, updatedAt: new Date() };
    await tx.insert(toolCredentials).values({ toolId: KEY_TOOL_ID, ...row }).onDuplicateKeyUpdate({ set: row });
    emit({ type: 'image_model.configured', entityType: 'tool', entityId: KEY_TOOL_ID, actor: 'owner', payload: { model, enabled: input.enabled } });
  });
}

export async function removeImageModel(ctx: OfficeContext) {
  await withTx(ctx, async (tx, emit) => {
    await tx.delete(toolCredentials).where(eq(toolCredentials.toolId, KEY_TOOL_ID));
    emit({ type: 'image_model.removed', entityType: 'tool', entityId: KEY_TOOL_ID, actor: 'owner' });
  });
}

/** Pemakaian model gambar dalam jendela bergulir 24 jam. */
export async function imageUsage(ctx: OfficeContext) {
  const since = (ms: number) => new Date(Date.now() - ms);
  const sum = async (from: Date) => {
    const [r] = await ctx.db
      // Yang dihitung ke jumlah: gambar yang jadi, atau percobaan yang sudah berbiaya. Gagal tanpa biaya tidak.
      .select({ count: sql<number>`coalesce(sum(${imageGenerations.status} = 'ok' or ${imageGenerations.costUsdMicros} > 0), 0)`.mapWith(Number), micros: sql<number>`coalesce(sum(${imageGenerations.costUsdMicros}), 0)`.mapWith(Number) })
      .from(imageGenerations)
      .where(gte(imageGenerations.createdAt, from));
    return { count: r!.count, costUsd: r!.micros / 1e6 };
  };
  return { day: await sum(since(24 * 3600_000)) };
}

/** Alasan kuota terlampaui, atau null bila masih boleh memakai model gambar. */
async function quotaBlock(ctx: OfficeContext) {
  const [perDay, costDay] = await Promise.all([
    getSetting(ctx.db, 'image_max_per_day'),
    getSetting(ctx.db, 'image_max_cost_usd_per_day'),
  ]);
  const u = await imageUsage(ctx);
  if (perDay > 0 && u.day.count >= perDay) return `kuota ${perDay} gambar per 24 jam tercapai`;
  if (costDay > 0 && u.day.costUsd >= costDay) return `batas biaya gambar $${costDay} per 24 jam tercapai`;
  return null;
}

/** Ukuran piksel dari header PNG atau JPEG; null bila format tidak dikenali. */
export function imageSize(buf: Buffer): { width: number; height: number; ext: 'png' | 'jpg' } | null {
  if (buf.length > 24 && buf.subarray(1, 4).toString() === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png' };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), ext: 'jpg' };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

interface OpenRouterImageResponse {
  choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
  usage?: { cost?: number };
  error?: { message?: string };
}

/** Model campuran (Gemini) butuh image+text; model khusus gambar (Seedream, FLUX) hanya menerima image. */
const MODALITIES = [['image', 'text'], ['image']] as const;
/** Bentuk yang terbukti diterima per model, agar penolakan modalitas tidak diulang di setiap gambar. */
const modalitiesOf = new Map<string, number>();

async function requestModelImage(key: string, model: string, prompt: string, doFetch: typeof fetch) {
  let res!: Response;
  let json: OpenRouterImageResponse = {};
  const start = modalitiesOf.get(model) ?? 0;
  for (const [i, modalities] of MODALITIES.entries()) {
    if (i < start) continue;
    res = await doFetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Virtual Office' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities, image_config: { aspect_ratio: '4:5' }, usage: { include: true } }),
      signal: AbortSignal.timeout(120_000),
    });
    json = (await res.json().catch(() => ({}))) as OpenRouterImageResponse;
    // Penolakan modalitas tidak berbiaya; coba bentuk permintaan berikutnya.
    if (res.status === 404 && /modalit/i.test(json.error?.message ?? '')) continue;
    if (res.ok) modalitiesOf.set(model, i);
    break;
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? 'permintaan ditolak'}`);
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? '';
  const m = url.match(/^data:image\/(?:png|jpe?g);base64,(.+)$/);
  if (!m) throw new Error('model tidak mengembalikan gambar PNG/JPEG');
  return { buf: Buffer.from(m[1]!, 'base64'), costUsd: json.usage?.cost ?? 0 };
}

let fontData: Promise<Buffer> | undefined;
const font = () => (fontData ??= readFile(createRequire(import.meta.url).resolve('@fontsource/inter/files/inter-latin-700-normal.woff')));

/** Teks di latar putih bersih, ukuran 1080×1350. Font tidak punya emoji, jadi emoji dibuang agar tidak jadi kotak. */
export async function renderTextImage(text: string): Promise<Buffer> {
  let clean = text.replace(/[\p{Extended_Pictographic}‍️]/gu, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) clean = ' ';
  if (clean.length > 400) clean = `${clean.slice(0, 399).trimEnd()}…`;
  const size = clean.length <= 40 ? 96 : clean.length <= 90 ? 76 : clean.length <= 160 ? 60 : clean.length <= 260 ? 48 : 40;
  const svg = await satori(
    {
      type: 'div',
      props: {
        style: { width: WIDTH, height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', padding: 110 },
        children: { type: 'div', props: { style: { fontSize: size, fontWeight: 700, lineHeight: 1.3, color: '#111111', textAlign: 'center', whiteSpace: 'pre-wrap' }, children: clean } },
      },
    },
    { width: WIDTH, height: HEIGHT, fonts: [{ name: 'Inter', data: await font(), weight: 700, style: 'normal' }] },
  );
  return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
}

async function saveMedia(ctx: OfficeContext, buf: Buffer, ext: 'png' | 'jpg') {
  const file = `${randomBytes(16).toString('hex')}.${ext}`;
  await mkdir(path.dirname(mediaPath(ctx, file)), { recursive: true });
  await writeFile(mediaPath(ctx, file), buf);
  return file;
}

export interface PostImage {
  file: string;
  source: 'model' | 'text';
  /** Mengapa memakai gambar teks padahal model gambar terpasang (kuota habis, gagal, dst). */
  reason?: string;
}

/**
 * Buat gambar post. Tidak pernah gagal karena model: ada cadangan teks di latar putih.
 * `text` adalah teks pendek yang tampil di gambar; `prompt` (opsional) petunjuk visual untuk model gambar.
 */
export async function createPostImage(ctx: OfficeContext, input: { text: string; prompt?: string }, opts: { fetch?: typeof fetch } = {}): Promise<PostImage> {
  const cfg = await imageModelConfig(ctx);
  const fallback = async (reason?: string): Promise<PostImage> => {
    const file = await saveMedia(ctx, await renderTextImage(input.text), 'png');
    await withTx(ctx, async (_tx, emit) => emit({ type: 'image.created', entityType: 'media', entityId: file, actor: 'orchestrator', payload: { source: 'text', reason } }));
    return { file, source: 'text', reason };
  };
  if (!cfg.enabled || !cfg.model) return fallback(cfg.configured ? 'model gambar dinonaktifkan' : undefined);
  const blocked = await quotaBlock(ctx);
  if (blocked) return fallback(blocked);

  const row = await storedRow(ctx);
  let outcome: { file: string; costUsd: number } | { error: string; costUsd: number };
  try {
    const key = ctx.secrets.decrypt(row!.secretEnc);
    const prompt = input.prompt?.trim()
      ? `${input.prompt.trim()}\n\nFormat potret 4:5.`
      : `Grafis media sosial minimalis, latar putih bersih, teks tebal gelap di tengah dengan tulisan persis: "${input.text}". Format potret 4:5.`;
    const out = await requestModelImage(key, cfg.model, prompt, opts.fetch ?? fetch);
    const size = imageSize(out.buf);
    if (!size) outcome = { error: 'format gambar dari model tidak dikenali', costUsd: out.costUsd };
    else if (size.width / size.height < MIN_RATIO - 0.01 || size.width / size.height > MAX_RATIO + 0.01) outcome = { error: `rasio gambar ${size.width}×${size.height} di luar 1:1–4:5`, costUsd: out.costUsd };
    else outcome = { file: await saveMedia(ctx, out.buf, size.ext), costUsd: out.costUsd };
  } catch (err) {
    outcome = { error: err instanceof Error ? err.message : String(err), costUsd: 0 };
  }
  await withTx(ctx, async (tx, emit) => {
    await tx.insert(imageGenerations).values({ id: randomUUID(), model: cfg.model, status: 'file' in outcome ? 'ok' : 'failed', costUsdMicros: Math.round(outcome.costUsd * 1e6) });
    emit({ type: 'image.created', entityType: 'media', entityId: 'file' in outcome ? outcome.file : cfg.model, actor: 'orchestrator', payload: { source: 'file' in outcome ? 'model' : 'text', model: cfg.model, costUsd: outcome.costUsd, error: 'error' in outcome ? outcome.error : undefined } });
  });
  if ('file' in outcome) return { file: outcome.file, source: 'model' };
  return fallback(`model gambar gagal (${outcome.error})`);
}

/** Alamat gambar yang bisa dibuka Instagram. Butuh alamat publik server dari halaman Akses. */
export async function publicImageUrl(ctx: OfficeContext, file: string) {
  if (!isMediaFile(file)) throw new UserError('Nama file gambar tidak valid');
  const base = (await getSetting(ctx.db, 'public_base_url')).trim().replace(/\/+$/, '');
  if (!base) throw new UserError('Alamat publik server belum diisi. Isi di halaman Akses › Model gambar agar Instagram bisa membuka gambarnya.');
  return `${base}/media/${file}`;
}
