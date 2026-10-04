import { createPostImage, publicImageUrl } from '../orchestrator/imagegen';
import { publishInstagramImage } from '../orchestrator/instagram';
import { z } from 'zod';
import { UserError } from '../domain';
import type { OfficeContext } from '../orchestrator/context';
import { searchKnowledge } from '../orchestrator/knowledge';
import { type OrgChangeArgs, applyOrgChange } from '../orchestrator/org';

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
  /** Dijalankan saat agent memanggil, sebelum permintaan persetujuan dicatat (mis. membuat gambar agar Owner bisa melihatnya). */
  prepare?(ctx: OfficeContext, args: z.infer<z.ZodObject<S>>): Promise<Record<string, unknown>>;
  execute(ctx: OfficeContext, args: z.infer<z.ZodObject<S>>, caller: Caller): Promise<unknown>;
}

const define = <S extends z.ZodRawShape>(t: ToolDef<S>) => t as unknown as ToolDef;

const OrgChangeShape = {
  type: z.enum(['hire', 'new_department', 'new_role', 'suspend', 'reactivate', 'retire']).describe('hire: tambah staf dari role yang ada (staf dirumahkan dipakai ulang lebih dulu); new_department: ruangan/divisi baru; new_role: role baru (otomatis merekrut satu staf); suspend: rumahkan agent (bisa dipakai kembali); reactivate: aktifkan kembali; retire: arsipkan agent yang tidak lagi diperlukan'),
  reason: z.string().min(3).max(500).describe('Alasan berbasis data, mis. antrean atau beban kerja'),
  role_id: z.string().max(64).optional().describe('hire: id role yang sudah ada'),
  runtime: z.enum(['claude-cli']).optional(),
  name: z.string().max(128).optional().describe('new_department / new_role: nama'),
  department_id: z.string().max(64).optional().describe('new_role: id divisi yang sudah ada'),
  color: z.string().max(9).optional(),
  instructions: z.string().max(3000).optional().describe('new_role: instruksi kerja role'),
  native_tools: z.enum(['read_only', 'workspace_write', 'research']).optional(),
  task_kind: z.enum(['work', 'research']).optional().describe('new_role: isi bila Manager boleh memakai role ini dalam rencana'),
  description: z.string().max(300).optional().describe('new_role: satu kalimat kemampuan role untuk daftar Manager'),
  tenure: z.enum(['permanent', 'on_demand', 'temporary']).optional().describe('hire: permanent (fungsi inti), on_demand (hidup hanya saat ada kerja), temporary (untuk satu objective)'),
  objective_id: z.string().max(36).optional().describe('hire temporary: id objective yang dilayani'),
  agent_id: z.string().max(36).optional().describe('suspend/reactivate/retire: id agent'),
};

export const TOOLS: ToolDef[] = [
  define({
    id: 'propose_org_change',
    title: 'Usulkan perubahan organisasi',
    description:
      'Usulkan staf tambahan (permanen, on-demand, atau sementara), merumahkan/mengaktifkan kembali/mengarsipkan agent, divisi (ruangan) baru, atau role baru. Tidak langsung berlaku: Owner harus menyetujui. Role baru hanya mendapat tool berisiko rendah.',
    risk: 'high',
    input: OrgChangeShape,
    async execute(ctx, args) {
      return applyOrgChange(ctx, args as OrgChangeArgs, 'owner', 'hrd-proposal');
    },
  }),
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
      'Minta publikasi satu gambar + caption ke akun Instagram perusahaan yang sudah dihubungkan Owner. Gambar dibuat sistem dari image_text (teks pendek di atas latar putih, atau model gambar bila Owner mengaktifkannya; image_prompt memberi petunjuk visual untuk model). Tidak langsung tayang kecuali Owner mengizinkan publikasi otomatis.',
    risk: 'high',
    input: {
      caption: z.string().min(1).max(2200),
      image_text: z.string().min(1).max(400).optional().describe('Teks singkat yang tampil di gambar (pesan inti post). Wajib bila tanpa image_url.'),
      image_prompt: z.string().max(1000).optional().describe('Petunjuk visual untuk model gambar; diabaikan bila model gambar tidak aktif'),
      image_url: z.string().url().optional().describe('URL gambar publik (JPEG/PNG) yang sudah ada; bila diisi, sistem tidak membuat gambar'),
    },
    async prepare(ctx, args) {
      if (args.image_url) return args;
      if (!args.image_text) throw new UserError('Isi image_text (teks di gambar) atau image_url');
      const image = await createPostImage(ctx, { text: args.image_text, prompt: args.image_prompt });
      return { ...args, image_file: image.file, image_source: image.source };
    },
    async execute(ctx, args) {
      const file = (args as { image_file?: string }).image_file;
      const imageUrl = file ? await publicImageUrl(ctx, file) : args.image_url;
      if (!imageUrl) throw new UserError('Gambar post tidak ada');
      // Akun datang dari NC-WA (halaman Akses); tidak ada token yang diketik manual.
      return publishInstagramImage(ctx, { imageUrl, caption: args.caption });
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
  hrd: ['knowledge_search', 'notify_owner', 'propose_org_change'],
  manager: ['knowledge_search', 'notify_owner', 'instagram_publish'],
  researcher: ['knowledge_search', 'notify_owner'],
  market_researcher: ['knowledge_search'],
  content_writer: ['knowledge_search', 'notify_owner', 'instagram_publish'],
};

/** Role buatan HRD/Owner hanya mendapat tool berisiko rendah; tidak bisa menambah izinnya sendiri (A6). */
export const DEFAULT_TOOLS = ['knowledge_search', 'notify_owner'];
export const allowedToolIds = (roleId: string) => ROLE_TOOLS[roleId] ?? DEFAULT_TOOLS;
export const toolsForRole = (roleId: string) => allowedToolIds(roleId).map(toolById).filter((t): t is ToolDef => !!t);
