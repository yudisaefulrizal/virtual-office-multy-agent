import { z } from 'zod';
import type { TaskKind } from '../domain';
import type { Capability } from '../runtimes/runtime';

/** Output task `work`: ringkasan + daftar file yang ditulis ke out/. */
export const WorkOutput = z.strictObject({
  summary: z.string().min(1).describe('Ringkasan singkat hasil kerja'),
  artifacts: z
    .array(
      z.strictObject({
        path: z.string().describe('Path relatif, diawali out/'),
        description: z.string(),
      }),
    )
    .describe('File yang ditulis ke folder out/'),
  assumptions: z.array(z.string()).optional().describe('Asumsi atau hal yang belum terverifikasi'),
});

interface KindSpec {
  schema: z.ZodType;
  requires: Capability[];
}

/** Task kind yang sudah didukung. Kind lain menyusul di Slice 2–3. */
export const TASK_KINDS: Partial<Record<TaskKind, KindSpec>> = {
  work: { schema: WorkOutput, requires: ['structured_output', 'workspace_files'] },
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
