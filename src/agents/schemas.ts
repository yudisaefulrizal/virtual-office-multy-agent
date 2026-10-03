import { z } from 'zod';
import type { TaskKind } from '../domain';
import type { Capability } from '../runtimes/runtime';
import { PLANNABLE_ROLES } from './roles';

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
};

export function kindSpec(kind: string): KindSpec {
  const spec = TASK_KINDS[kind as TaskKind];
  if (!spec) throw new Error(`Task kind belum didukung: ${kind}`);
  return spec;
}

export function jsonSchemaFor(kind: string): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(kindSpec(kind).schema) as Record<string, unknown>;
  return schema;
}
