import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { toolCredentials } from '../db/schema';
import { UserError } from '../domain';
import type { OfficeContext } from '../orchestrator/context';
import { searchKnowledge } from '../orchestrator/knowledge';

export interface Caller {
  agentId: string;
  agentName: string;
  roleId: string;
  taskId: string;
  sessionId: string;
  objectiveId: string;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  title: string;
  description: string;
  /** high: tidak dieksekusi saat dipanggil agent; menunggu persetujuan Owner (DESIGN.md §21). */
  risk: 'low' | 'high';
  input: S;
  /** Credential yang harus dipasang Owner sebelum tool bisa dieksekusi. */
  credential?: { label: string; configFields: { key: string; label: string }[] };
  execute(ctx: OfficeContext, args: z.infer<z.ZodObject<S>>, caller: Caller): Promise<unknown>;
}

const define = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;

async function credentialFor(ctx: OfficeContext, toolId: string) {
  const [row] = await ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, toolId));
  if (!row) throw new UserError(`Credential untuk ${toolId} belum dipasang Owner`);
  return { secret: ctx.secrets.decrypt(row.secretEnc), config: row.config as Record<string, string> };
}

export const TOOLS: ToolDef[] = [
  define({
    id: 'knowledge_search',
    title: 'Cari knowledge organisasi',
    description: 'Cari knowledge yang sudah diriset organisasi sebelum melakukan riset baru.',
    risk: 'low',
    input: { query: z.string().min(2).max(200).describe('Kata kunci topik') },
    async execute(ctx, { query }) {
      const rows = await searchKnowledge(ctx.db, query, 5);
      const now = new Date();
      return rows.map((r) => ({
        topic: r.topic,
        category: r.category,
        content: r.content,
        sources: r.sources,
        confidence: r.confidence,
        needsRecheck: r.recheckAfter <= now,
      }));
    },
  }),
  define({
    id: 'notify_owner',
    title: 'Kabari Owner',
    description: 'Kirim pesan singkat ke Owner untuk hal yang butuh perhatian manusia. Jangan untuk laporan rutin.',
    risk: 'low',
    input: { title: z.string().min(3).max(120), message: z.string().min(3).max(2000) },
    async execute() {
      // Pesannya sendiri dicatat sebagai event oleh Gateway (tool.executed + owner.notified).
      return { delivered: true };
    },
  }),
  define({
    id: 'instagram_publish',
    title: 'Publish ke Instagram',
    description:
      'Minta publikasi foto + caption ke akun Instagram perusahaan. Tidak langsung tayang: Owner harus menyetujui lebih dulu.',
    risk: 'high',
    input: {
      image_url: z.string().url().describe('URL gambar publik (JPEG) yang bisa diakses Instagram'),
      caption: z.string().min(1).max(2200),
    },
    credential: {
      label: 'Access token Instagram Graph API',
      configFields: [
        { key: 'ig_user_id', label: 'Instagram Business Account ID' },
        { key: 'api_version', label: 'Versi Graph API (mis. v21.0)' },
      ],
    },
    async execute(ctx, { image_url, caption }) {
      const { secret, config } = await credentialFor(ctx, 'instagram_publish');
      const base = `https://graph.facebook.com/${config.api_version || 'v21.0'}/${config.ig_user_id}`;
      const post = async (url: string, params: Record<string, string>) => {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ ...params, access_token: secret }) });
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
        if (!res.ok || !body.id) throw new Error(`Instagram: ${body.error?.message ?? `HTTP ${res.status}`}`);
        return body.id;
      };
      const creationId = await post(`${base}/media`, { image_url, caption });
      const mediaId = await post(`${base}/media_publish`, { creation_id: creationId });
      return { mediaId };
    },
  }),
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);

/**
 * Izin tool per role. Ditulis di kode agar deterministik dan teraudit lewat git;
 * agent tidak bisa menambah izinnya sendiri (DESIGN.md §20).
 */
export const ROLE_TOOLS: Record<string, string[]> = {
  ceo: ['knowledge_search', 'notify_owner'],
  cfo: ['knowledge_search', 'notify_owner'],
  cto: ['knowledge_search', 'notify_owner'],
  hrd: ['knowledge_search', 'notify_owner'],
  manager: ['knowledge_search', 'notify_owner', 'instagram_publish'],
  researcher: ['knowledge_search', 'notify_owner'],
  market_researcher: ['knowledge_search'],
  content_writer: ['knowledge_search', 'notify_owner', 'instagram_publish'],
};

export const toolsForRole = (roleId: string) => (ROLE_TOOLS[roleId] ?? []).map(toolById).filter((t): t is ToolDef => !!t);
