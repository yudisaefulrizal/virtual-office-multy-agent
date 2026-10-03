import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { agents, artifacts, objectives, tasks } from '../db/schema';
import type { OfficeContext } from './context';

export interface ResultFile {
  id: string;
  name: string; // nama tampilan: path relatif terhadap folder out/ task
  mimeType: string | null;
  bytes: number;
  createdAt: string;
}

export interface ResultOutput {
  taskId: string;
  title: string;
  kind: string;
  agentName: string | null;
  summary: string | null;
  completedAt: string | null;
  files: ResultFile[];
}

export interface ObjectiveResult {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  fileCount: number;
  totalBytes: number;
  outputs: ResultOutput[];
}

/** Nama file relatif terhadap folder `out/` milik task (bagian setelah segmen "/out/"). */
export function displayName(p: string) {
  const i = p.lastIndexOf('/out/');
  return i >= 0 ? p.slice(i + 5) : path.basename(p);
}

const summaryOf = (result: unknown): string | null => {
  const s = (result as { summary?: unknown } | null)?.summary;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
};

/**
 * Hasil kerja per objective: task work/research yang selesai (versi terbaru per plan key,
 * revisi lama tidak ditampilkan) beserta file di out/-nya. Objective tanpa hasil tidak dimuat.
 */
export async function listResults(ctx: OfficeContext, onlyObjectiveId?: string): Promise<ObjectiveResult[]> {
  const db = ctx.db;
  const objs = await db
    .select()
    .from(objectives)
    .where(onlyObjectiveId ? eq(objectives.id, onlyObjectiveId) : undefined)
    .orderBy(desc(objectives.createdAt));
  if (objs.length === 0) return [];

  const rows = await db
    .select({ task: tasks, agentName: agents.name })
    .from(tasks)
    .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
    .where(and(eq(tasks.status, 'completed'), inArray(tasks.objectiveId, objs.map((o) => o.id))))
    .orderBy(asc(tasks.completedAt), asc(tasks.createdAt));
  const taskIds = rows.map((r) => r.task.id);
  const files = taskIds.length ? await db.select().from(artifacts).where(inArray(artifacts.taskId, taskIds)).orderBy(asc(artifacts.path)) : [];

  const results: ObjectiveResult[] = [];
  for (const o of objs) {
    // Versi terbaru per plan key; task tanpa key (mode direct) dihitung masing-masing.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows.filter((r) => r.task.objectiveId === o.id)) {
      if (r.task.kind !== 'work' && r.task.kind !== 'research' && !files.some((f) => f.taskId === r.task.id)) continue;
      latest.set(r.task.planKey ? `${r.task.projectId}:${r.task.planKey}` : r.task.id, r);
    }
    const outputs: ResultOutput[] = [...latest.values()].map(({ task, agentName }) => ({
      taskId: task.id,
      title: task.title,
      kind: task.kind,
      agentName,
      summary: summaryOf(task.result),
      completedAt: task.completedAt?.toISOString() ?? null,
      files: files
        .filter((f) => f.taskId === task.id)
        .map((f) => ({ id: f.id, name: displayName(f.path), mimeType: f.mimeType, bytes: f.bytes, createdAt: f.createdAt.toISOString() })),
    }));
    if (outputs.length === 0) continue;
    results.push({
      id: o.id,
      title: o.title,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      updatedAt: outputs.map((x) => x.completedAt).filter(Boolean).sort().at(-1) ?? null,
      fileCount: outputs.reduce((n, x) => n + x.files.length, 0),
      totalBytes: outputs.reduce((n, x) => n + x.files.reduce((s, f) => s + f.bytes, 0), 0),
      outputs,
    });
  }
  return results;
}

/** Nama aman untuk file/folder unduhan. */
export const safeName = (s: string, fallback = 'hasil') =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || fallback;

/** Baca file artifact; path hanya valid bila berada di dalam folder workspaces. */
export async function readWorkspaceFile(ctx: OfficeContext, rel: string) {
  const full = path.resolve(ctx.workspacesDir, rel);
  if (!full.startsWith(ctx.workspacesDir + path.sep)) throw new Error('Path di luar workspace');
  return readFile(full);
}

interface ZipEntry {
  name: string;
  data: Buffer;
  date?: Date;
}

/** ZIP minimal (deflate, tanpa ZIP64): cukup untuk kumpulan hasil kerja. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = deflateRawSync(e.data);
    const useDeflate = packed.length < e.data.length;
    const body = useDeflate ? packed : e.data;
    const d = e.date ?? new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nama file UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** ZIP hasil satu objective: folder per task + RINGKASAN.md. File yang sudah hilang dilewati. */
export async function objectiveZip(ctx: OfficeContext, objectiveId: string) {
  const [result] = await listResults(ctx, objectiveId);
  if (!result) return null;
  const paths = result.outputs.flatMap((o) => o.files.map((f) => f.id));
  const rows = paths.length ? await ctx.db.select().from(artifacts).where(inArray(artifacts.id, paths)) : [];
  const pathOf = new Map(rows.map((r) => [r.id, r.path]));

  const entries: ZipEntry[] = [];
  const summary: string[] = [`# ${result.title}`, ''];
  const used = new Set<string>();
  for (const [i, o] of result.outputs.entries()) {
    const folder = `${String(i + 1).padStart(2, '0')}-${safeName(o.title, 'task')}`;
    summary.push(`## ${o.title}`, `_${o.kind}${o.agentName ? ` · ${o.agentName}` : ''}_`, '', o.summary ?? '(tanpa ringkasan)', '');
    for (const f of o.files) {
      const rel = pathOf.get(f.id);
      const data = rel ? await readWorkspaceFile(ctx, rel).catch(() => null) : null;
      if (!data) {
        summary.push(`- ${f.name} (file sudah tidak ada)`);
        continue;
      }
      let name = `${folder}/${f.name}`;
      for (let n = 2; used.has(name); n++) name = `${folder}/${n}-${f.name}`;
      used.add(name);
      entries.push({ name, data });
      summary.push(`- ${name}`);
    }
    summary.push('');
  }
  entries.unshift({ name: 'RINGKASAN.md', data: Buffer.from(summary.join('\n'), 'utf8') });
  return { title: result.title, zip: buildZip(entries) };
}
