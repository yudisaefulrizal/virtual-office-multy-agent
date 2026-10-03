import { z } from 'zod';
import type { TaskKind } from '../domain';
import type { Capability } from '../runtimes/runtime';
import { CONSULTABLE_ROLES, PLANNABLE_ROLES, ROLES } from './roles';

const ArtifactRef = z.strictObject({
  path: z.string().describe('Path relatif, diawali out/'),
  description: z.string(),
});

/** Output task `work`: ringkasan + daftar file yang ditulis ke out/. */
export const WorkOutput = z.strictObject({
  summary: z.string().min(1).describe('Ringkasan singkat hasil kerja'),
  artifacts: z.array(ArtifactRef).describe('File yang ditulis ke folder out/'),
  assumptions: z.array(z.string()).optional().describe('Asumsi atau hal yang belum terverifikasi'),
});

/** Output task `research`: temuan dengan sumber. R&D menyediakan evidence, bukan keputusan. */
export const ResearchOutput = z.strictObject({
  summary: z.string().min(1),
  findings: z
    .array(
      z.strictObject({
        point: z.string().min(1),
        source: z.string().describe('URL sumber, atau "tidak terverifikasi"'),
      }),
    )
    .min(1),
  artifacts: z.array(ArtifactRef).describe('Catatan riset yang ditulis ke folder out/'),
  assumptions: z.array(z.string()).optional(),
});

const roleIds = Object.keys(PLANNABLE_ROLES) as [string, ...string[]];

/** Output task `planning` (Manager): rencana task dengan dependency. */
export const PlanOutput = z.strictObject({
  summary: z.string().min(1).describe('Ringkasan pendekatan'),
  tasks: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/).describe('ID singkat: huruf kecil, angka, tanda hubung'),
        title: z.string().min(3).max(200),
        role: z.enum(roleIds),
        instructions: z.string().min(10),
        depends_on: z.array(z.string()).describe('Key task yang harus selesai lebih dulu'),
      }),
    )
    .min(1)
    .max(4),
  review_focus: z.string().min(1).describe('Kriteria yang akan dicek saat review'),
});
export type Plan = z.infer<typeof PlanOutput>;

/** Output task `review` (Manager). */
export const ReviewOutput = z.strictObject({
  verdict: z.enum(['accept', 'revise']),
  feedback: z.string().min(1),
  revisions: z
    .array(z.strictObject({ task_key: z.string(), instructions: z.string().min(5) }))
    .describe('Wajib diisi jika verdict revise; kosongkan jika accept'),
});
export type Review = z.infer<typeof ReviewOutput>;

const consultable = Object.keys(CONSULTABLE_ROLES) as [string, ...string[]];

/** Output task `framing` (CEO): visi + pertanyaan selektif ke eksekutif/R&D. */
export const FramingOutput = z.strictObject({
  vision: z.string().min(1).describe('Visi dan arah besar untuk objective ini'),
  questions: z
    .array(z.strictObject({ to: z.enum(consultable), question: z.string().min(10) }))
    .max(4)
    .describe('Konsultasi yang benar-benar dibutuhkan; kosongkan bila tidak perlu'),
});
export type Framing = z.infer<typeof FramingOutput>;

/** Output task `consultation` (CFO/CTO/HRD): analisis dengan alternatif, bukan sekadar menolak. */
export const ConsultationOutput = z.strictObject({
  analysis: z.string().min(1),
  risks: z.array(z.string()),
  recommendation: z.string().min(1),
  alternatives: z.array(z.string()).describe('Alternatif yang lebih feasible, wajib minimal satu'),
});

const roleIdsAll = ROLES.filter((r) => r.id !== 'ceo').map((r) => r.id) as [string, ...string[]];

/** Output task `decision` (CEO): usulan keputusan yang menunggu persetujuan Owner. */
export const DecisionOutput = z.strictObject({
  strategy: z.string().min(1),
  success_metrics: z.array(z.string()).min(1),
  budget_cap_usd: z.number().min(0).describe('Batas biaya API untuk objective ini; 0 = tanpa batas tambahan'),
  team: z
    .array(
      z.strictObject({
        role: z.enum(roleIdsAll).describe('Hanya role yang sudah ada'),
        runtime: z.enum(['claude-cli', 'openrouter']),
        reason: z.string().min(1),
      }),
    )
    .describe('Susunan tim yang dibutuhkan (usulan HRD, dirangkum CEO)'),
  owner_requests: z
    .array(
      z.strictObject({
        type: z.enum(['provider', 'budget', 'tool', 'other']),
        key: z.string().min(1).describe('mis. openrouter, instagram'),
        reason: z.string().min(1),
        amount_usd: z.number().min(0).optional(),
      }),
    )
    .describe('Hal yang perlu disediakan Owner. Jangan pernah meminta API key ditulis di sini.'),
  execution_brief: z.string().min(1).describe('Arahan untuk Manager saat menyusun rencana kerja'),
});
export type DecisionProposal = z.infer<typeof DecisionOutput>;

export function checkFraming(f: Framing): string | null {
  const seen = new Set<string>();
  for (const q of f.questions) {
    if (seen.has(q.to)) return `Pertanyaan untuk ${q.to} ganda; gabungkan menjadi satu`;
    seen.add(q.to);
  }
  return null;
}

/** Validasi semantik setelah schema lolos. Mengembalikan pesan error, atau null. */
export function checkPlan(plan: Plan): string | null {
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) return `Key task duplikat: ${t.key}`;
    keys.add(t.key);
  }
  for (const t of plan.tasks) {
    for (const d of t.depends_on) {
      if (d === t.key) return `Task ${t.key} tidak boleh bergantung pada dirinya sendiri`;
      if (!keys.has(d)) return `Task ${t.key} bergantung pada key yang tidak ada: ${d}`;
    }
  }
  return topoOrder(plan) ? null : 'Rencana mengandung dependency melingkar';
}

/** Urutan topologis rencana, atau null jika ada siklus. */
export function topoOrder(plan: Plan): Plan['tasks'] | null {
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: Plan['tasks'] = [];
  const visit = (k: string): boolean => {
    if (done.has(k)) return true;
    if (visiting.has(k)) return false;
    visiting.add(k);
    for (const d of byKey.get(k)?.depends_on ?? []) if (!visit(d)) return false;
    visiting.delete(k);
    done.add(k);
    out.push(byKey.get(k)!);
    return true;
  };
  for (const t of plan.tasks) if (!visit(t.key)) return null;
  return out;
}

export function checkReview(review: Review, input: unknown): string | null {
  if (review.verdict === 'accept') return null;
  if (review.revisions.length === 0) return 'Verdict revise wajib menyertakan minimal satu revisi';
  const planKeys = ((input as { planKeys?: string[] })?.planKeys ?? []) as string[];
  const unknown = review.revisions.find((r) => !planKeys.includes(r.task_key));
  return unknown ? `task_key tidak dikenal: ${unknown.task_key}. Pilih dari: ${planKeys.join(', ')}` : null;
}

interface KindSpec {
  schema: z.ZodType;
  requires: Capability[];
  timeoutMs: number;
  check?: (data: any, input: unknown) => string | null;
}

export const TASK_KINDS: Partial<Record<TaskKind, KindSpec>> = {
  work: { schema: WorkOutput, requires: ['structured_output', 'workspace_files'], timeoutMs: 600_000 },
  research: { schema: ResearchOutput, requires: ['structured_output', 'workspace_files', 'web_research'], timeoutMs: 900_000 },
  planning: { schema: PlanOutput, requires: ['structured_output'], timeoutMs: 300_000, check: checkPlan },
  review: { schema: ReviewOutput, requires: ['structured_output', 'workspace_files'], timeoutMs: 300_000, check: checkReview },
  framing: { schema: FramingOutput, requires: ['structured_output'], timeoutMs: 300_000, check: checkFraming },
  consultation: { schema: ConsultationOutput, requires: ['structured_output'], timeoutMs: 300_000 },
  decision: { schema: DecisionOutput, requires: ['structured_output'], timeoutMs: 300_000 },
};

/**
 * Ringkasan hasil task untuk diteruskan ke task berikutnya lewat prompt.
 * Penting untuk runtime API yang tidak bisa membaca file context/.
 */
export function resultDigest(kind: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, any>;
  const list = (xs: unknown, label: string) => (Array.isArray(xs) && xs.length ? `\n${label}:\n${xs.map((x) => `- ${typeof x === 'string' ? x : x.point ? `${x.point} (${x.source})` : JSON.stringify(x)}`).join('\n')}` : '');
  switch (kind) {
    case 'consultation':
      return `Rekomendasi: ${r.recommendation}\nAnalisis: ${r.analysis}${list(r.risks, 'Risiko')}${list(r.alternatives, 'Alternatif')}`;
    case 'research':
      return `${r.summary ?? ''}${list(r.findings, 'Temuan')}`;
    case 'framing':
      return `Visi: ${r.vision}`;
    case 'decision':
      return `Strategi: ${r.strategy}\nArahan: ${r.execution_brief}`;
    default:
      return r.summary ?? '';
  }
}

export function kindSpec(kind: string): KindSpec {
  const spec = TASK_KINDS[kind as TaskKind];
  if (!spec) throw new Error(`Task kind belum didukung: ${kind}`);
  return spec;
}

export function jsonSchemaFor(kind: string): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(kindSpec(kind).schema) as Record<string, unknown>;
  return schema;
}
