import { randomUUID } from 'node:crypto';
import { desc, eq, like, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { knowledge } from '../db/schema';
import type { Emit } from './context';

export const KNOWLEDGE_CATEGORIES = ['api', 'pricing', 'policy', 'market', 'trend', 'content', 'technology', 'general'] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** Berapa lama knowledge dianggap valid sebelum perlu diverifikasi ulang (DESIGN.md A8). */
export const RECHECK_DAYS: Record<KnowledgeCategory, number> = {
  api: 30,
  pricing: 30,
  policy: 30,
  market: 14,
  trend: 14,
  content: 60,
  technology: 90,
  general: 180,
};

export interface KnowledgeInput {
  topic: string;
  category: KnowledgeCategory;
  content: string;
  sources: string[];
}

const urlOf = (s: string) => (/^https?:\/\/\S+$/i.test(s.trim()) ? s.trim() : null);

/** Keyakinan dari jumlah sumber yang bisa dicek, bukan dari klaim model. */
export function confidenceOf(sources: string[]) {
  const urls = new Set(sources.map(urlOf).filter(Boolean));
  return urls.size >= 2 ? 'high' : urls.size === 1 ? 'medium' : 'low';
}

export const topicKeyOf = (topic: string) => topic.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 255);

/** Simpan atau perbarui knowledge per topik; riset ulang memperbarui tanggal verifikasi. */
export async function upsertKnowledge(
  tx: Tx,
  emit: Emit,
  items: KnowledgeInput[],
  origin: { taskId: string; objectiveId: string; actor: `agent:${string}` },
) {
  const now = new Date();
  for (const k of items) {
    const topicKey = topicKeyOf(k.topic);
    if (!topicKey || !k.content.trim()) continue;
    const sources = [...new Set(k.sources.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
    const values = {
      topic: k.topic.trim().slice(0, 255),
      category: k.category,
      content: k.content.trim(),
      sources,
      confidence: confidenceOf(sources),
      lastVerifiedAt: now,
      recheckAfter: new Date(now.getTime() + RECHECK_DAYS[k.category] * 86_400_000),
      createdByTaskId: origin.taskId,
      objectiveId: origin.objectiveId,
      updatedAt: now,
    };
    const [existing] = await tx.select({ id: knowledge.id }).from(knowledge).where(eq(knowledge.topicKey, topicKey));
    const id = existing?.id ?? randomUUID();
    if (existing) await tx.update(knowledge).set(values).where(eq(knowledge.id, id));
    else await tx.insert(knowledge).values({ id, topicKey, researchedAt: now, ...values });
    emit({
      type: existing ? 'knowledge.updated' : 'knowledge.created',
      entityType: 'knowledge',
      entityId: id,
      objectiveId: origin.objectiveId,
      actor: origin.actor,
      payload: { topic: values.topic, category: k.category, confidence: values.confidence },
    });
  }
}

const STOPWORDS = new Set(
  'yang untuk dengan dari pada dalam akan atau juga tidak lebih bisa agar serta sebagai setiap tentang buat buatkan satu hari ini itu adalah kami kita mereka oleh karena tulis berkualitas the and for with from that this into'.split(' '),
);

export function keywordsOf(text: string, max = 8) {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

export type KnowledgeRow = typeof knowledge.$inferSelect;

/** Pencarian sederhana berbasis kata kunci; topik yang cocok diberi bobot lebih. */
export async function searchKnowledge(tx: Tx, text: string, limit = 5): Promise<KnowledgeRow[]> {
  const words = keywordsOf(text);
  if (words.length === 0) return [];
  const rows = await tx
    .select()
    .from(knowledge)
    .where(or(...words.flatMap((w) => [like(knowledge.topicKey, `%${w}%`), like(knowledge.content, `%${w}%`)])))
    .orderBy(desc(knowledge.lastVerifiedAt))
    .limit(50);
  const score = (r: KnowledgeRow) =>
    words.reduce((s, w) => s + (r.topicKey.includes(w) ? 3 : 0) + (r.content.toLowerCase().includes(w) ? 1 : 0), 0);
  return rows.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

export async function listKnowledge(tx: Tx, opts: { q?: string; category?: string }) {
  if (opts.q?.trim()) {
    const rows = await searchKnowledge(tx, opts.q, 100);
    return opts.category ? rows.filter((r) => r.category === opts.category) : rows;
  }
  return tx
    .select()
    .from(knowledge)
    .where(opts.category ? eq(knowledge.category, opts.category) : sql`true`)
    .orderBy(desc(knowledge.updatedAt))
    .limit(200);
}

export const isStale = (r: Pick<KnowledgeRow, 'recheckAfter'>, now = new Date()) => r.recheckAfter <= now;

/** Bagian prompt: knowledge yang relevan, dengan penanda valid / perlu verifikasi ulang. */
export function knowledgePromptSection(rows: KnowledgeRow[], forResearch: boolean) {
  if (rows.length === 0) return '';
  const now = new Date();
  const items = rows.map((r) => {
    const status = isStale(r, now)
      ? `PERLU VERIFIKASI ULANG (dicek terakhir ${r.lastVerifiedAt.toISOString().slice(0, 10)})`
      : `valid sampai ${r.recheckAfter.toISOString().slice(0, 10)}`;
    const sources = (r.sources as string[]).slice(0, 3).join(', ') || 'tanpa sumber';
    return `### ${r.topic} [${r.category}, keyakinan ${r.confidence}, ${status}]\n${r.content.slice(0, 600)}\nSumber: ${sources}`;
  });
  return [
    '',
    '## Knowledge organisasi yang relevan',
    '',
    ...items,
    '',
    forResearch
      ? 'Pakai ulang knowledge yang masih valid. Riset ulang hanya yang perlu diverifikasi atau belum ada.'
      : 'Pakai knowledge yang masih valid. Jangan mengandalkan yang perlu verifikasi ulang tanpa menyebutnya sebagai asumsi.',
  ].join('\n');
}
