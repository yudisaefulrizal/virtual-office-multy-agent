import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ne } from 'drizzle-orm';
import { DEPARTMENT_COLORS, type PlannableRole } from '../agents/roles';
import type { Tx } from '../db/client';
import { agents, departments, providers, roles } from '../db/schema';
import { UserError, type Actor } from '../domain';
import type { RuntimeId } from '../runtimes/runtime';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';
import { getAllSettings } from './settings';

export type RoleRow = typeof roles.$inferSelect;

export const NATIVE_TOOLS = ['read_only', 'workspace_write', 'research'] as const;

const slug = (s: string, sep: '-' | '_') =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    .slice(0, 48);

/** Role yang boleh dipakai Manager dalam rencana kerja, dari database. */
export async function loadPlannableRoles(tx: Tx): Promise<(PlannableRole & { name: string })[]> {
  const rows = await tx.select().from(roles).where(eq(roles.plannable, true)).orderBy(asc(roles.id));
  return rows
    .filter((r) => r.taskKind === 'work' || r.taskKind === 'research')
    .map((r) => ({ id: r.id, name: r.name, kind: r.taskKind as 'work' | 'research', description: r.description ?? r.name }));
}

async function uniqueId(tx: Tx, table: 'departments' | 'roles', base: string, sep: '-' | '_') {
  const t = table === 'departments' ? departments : roles;
  for (let i = 0; i < 50; i++) {
    const id = i === 0 ? base : `${base}${sep}${i + 1}`;
    const [row] = await tx.select({ id: t.id }).from(t).where(eq(t.id, id));
    if (!row) return id;
  }
  throw new UserError('Tidak bisa membuat id unik');
}

/**
 * Rekrut satu karyawan dari role yang sudah ada (DESIGN.md A6: agent baru hanya dari role yang ada).
 * Runtime default mengikuti staf role itu sekarang.
 */
export async function hireAgent(
  ctx: OfficeContext,
  tx: Tx,
  emit: Emit,
  input: { roleId: string; runtime?: RuntimeId; actor: Actor; createdBy: string; reason: string; objectiveId?: string | null },
) {
  const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId));
  if (!role) throw new UserError(`Role ${input.roleId} tidak ada`);
  const staff = await tx.select().from(agents).where(eq(agents.roleId, role.id)).orderBy(asc(agents.createdAt));
  const active = staff.filter((a) => a.status !== 'inactive');
  const runtime = input.runtime ?? ((active[0] ?? staff[0])?.runtime as RuntimeId | undefined) ?? 'claude-cli';

  let name = role.name;
  for (let n = staff.length + 1; (await tx.select({ id: agents.id }).from(agents).where(eq(agents.name, name))).length > 0; n++) {
    name = `${role.name} ${n}`;
  }
  let model: string | null = null;
  if (runtime === 'claude-cli') model = ctx.defaultModel;
  else {
    const [p] = await tx.select().from(providers).where(eq(providers.id, runtime));
    model = p?.defaultModel ?? null;
  }
  const id = randomUUID();
  const status = ctx.runtimes.has(effectiveRuntime(ctx, runtime)) ? 'active' : 'waiting_provider';
  await tx.insert(agents).values({
    id,
    roleId: role.id,
    name,
    runtime,
    model,
    status,
    supervisorAgentId: staff[0]?.supervisorAgentId ?? null,
    workspacePath: `agents/${id}`,
    createdBy: input.createdBy,
  });
  emit({
    type: 'agent.created',
    entityType: 'agent',
    entityId: id,
    objectiveId: input.objectiveId ?? null,
    actor: input.actor,
    payload: { name, roleId: role.id, runtime, reason: input.reason },
  });
  return { id, name, status };
}

export interface OrgChangeArgs {
  type: 'hire' | 'new_department' | 'new_role';
  reason: string;
  role_id?: string;
  runtime?: 'claude-cli' | 'openrouter';
  name?: string;
  department_id?: string;
  color?: string;
  instructions?: string;
  native_tools?: (typeof NATIVE_TOOLS)[number];
  task_kind?: 'work' | 'research';
  description?: string;
}

/** Ringkasan satu baris untuk inbox Owner. */
export function describeOrgChange(a: Partial<OrgChangeArgs>) {
  switch (a.type) {
    case 'hire':
      return `Rekrut 1 staf ${a.role_id}${a.runtime ? ` (${a.runtime})` : ''}. Alasan: ${a.reason}`;
    case 'new_department':
      return `Divisi baru "${a.name}" (ruangan baru). Alasan: ${a.reason}`;
    case 'new_role':
      return `Role baru "${a.name}" di divisi ${a.department_id}, akses file: ${a.native_tools ?? 'read_only'}${a.task_kind ? `, bisa dipakai Manager (${a.task_kind})` : ''}. Alasan: ${a.reason}`;
    default:
      return JSON.stringify(a);
  }
}

/**
 * Terapkan perubahan organisasi. Dipanggil Owner langsung, atau oleh sistem setelah Owner
 * menyetujui usulan (HRD / aturan staffing). Role baru hanya mendapat tool berisiko rendah.
 */
export async function applyOrgChange(ctx: OfficeContext, args: OrgChangeArgs, actor: Actor, createdBy = 'owner') {
  return withTx(ctx, async (tx, emit) => {
    switch (args.type) {
      case 'hire': {
        if (!args.role_id) throw new UserError('role_id wajib untuk rekrut staf');
        // Batas staf per role hanya mengikat aturan otomatis; persetujuan Owner boleh melampauinya.
        return hireAgent(ctx, tx, emit, { roleId: args.role_id, runtime: args.runtime, actor, createdBy, reason: args.reason });
      }
      case 'new_department': {
        const name = args.name?.trim();
        if (!name || name.length < 3) throw new UserError('Nama divisi minimal 3 karakter');
        const id = await uniqueId(tx, 'departments', slug(name, '-') || 'divisi', '-');
        const existing = await tx.select({ sortOrder: departments.sortOrder }).from(departments).orderBy(desc(departments.sortOrder)).limit(1);
        const total = (await tx.select({ n: count() }).from(departments))[0]?.n ?? 0;
        const color = /^#[0-9a-fA-F]{6}$/.test(args.color ?? '') ? args.color! : DEPARTMENT_COLORS[total % DEPARTMENT_COLORS.length]!;
        await tx.insert(departments).values({ id, name, color, sortOrder: (existing[0]?.sortOrder ?? 0) + 1, createdBy });
        emit({ type: 'department.created', entityType: 'department', entityId: id, actor, payload: { name, reason: args.reason } });
        return { id, name };
      }
      case 'new_role': {
        const name = args.name?.trim();
        if (!name || name.length < 3) throw new UserError('Nama role minimal 3 karakter');
        if (!args.department_id) throw new UserError('department_id wajib');
        const [dept] = await tx.select().from(departments).where(eq(departments.id, args.department_id));
        if (!dept) throw new UserError(`Divisi ${args.department_id} tidak ada`);
        if ((args.instructions?.trim().length ?? 0) < 20) throw new UserError('Instruksi role minimal 20 karakter');
        const nativeTools = args.native_tools ?? 'read_only';
        if (!NATIVE_TOOLS.includes(nativeTools)) throw new UserError('native_tools tidak valid');
        if (args.task_kind && !(args.description?.trim().length)) throw new UserError('description wajib untuk role yang bisa dipakai Manager');
        const id = await uniqueId(tx, 'roles', slug(name, '_') || 'role_baru', '_');
        await tx.insert(roles).values({
          id,
          name,
          department: dept.id,
          instructions: args.instructions!.trim(),
          nativeTools,
          plannable: !!args.task_kind,
          taskKind: args.task_kind ?? null,
          description: args.description?.trim() ?? null,
          createdBy,
        });
        emit({ type: 'role.created', entityType: 'role', entityId: id, actor, payload: { name, department: dept.id, nativeTools, reason: args.reason } });
        // Role tanpa karyawan tidak berguna: rekrut satu.
        const first = await hireAgent(ctx, tx, emit, { roleId: id, runtime: args.runtime ?? 'claude-cli', actor, createdBy, reason: `Staf pertama role ${name}` });
        return { id, name, agent: first };
      }
      default:
        throw new UserError('Jenis perubahan organisasi tidak dikenal');
    }
  });
}

/** Susunan organisasi untuk halaman Pengaturan. */
export async function listOrg(ctx: OfficeContext) {
  const [depts, roleRows, agentRows, settings] = await Promise.all([
    ctx.db.select().from(departments).orderBy(asc(departments.sortOrder), asc(departments.id)),
    ctx.db.select().from(roles).orderBy(asc(roles.id)),
    ctx.db.select().from(agents),
    getAllSettings(ctx.db),
  ]);
  return {
    limits: { maxStaffPerRole: settings.max_staff_per_role, autoHire: settings.auto_hire, hireWaitSeconds: settings.hire_wait_seconds },
    departments: depts.map((d) => {
      const rs = roleRows.filter((r) => r.department === d.id);
      return {
        id: d.id,
        name: d.name,
        color: d.color,
        createdBy: d.createdBy,
        staff: agentRows.filter((a) => rs.some((r) => r.id === a.roleId) && a.status !== 'inactive').length,
        roles: rs.map((r) => ({
          id: r.id,
          name: r.name,
          nativeTools: r.nativeTools,
          plannable: r.plannable,
          taskKind: r.taskKind,
          createdBy: r.createdBy,
          staff: agentRows.filter((a) => a.roleId === r.id && a.status !== 'inactive').length,
        })),
      };
    }),
  };
}
