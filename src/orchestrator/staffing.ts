import { and, eq, gt, lte, ne } from 'drizzle-orm';
import { kindSpec } from '../agents/schemas';
import { agents, approvals, events, roles, tasks } from '../db/schema';
import type { RuntimeId } from '../runtimes/runtime';
import { type OfficeContext, effectiveRuntime, withTx } from './context';
import { hireAgent } from './org';
import { getAllSettings } from './settings';

export interface RuntimeLoad {
  inflight: number;
  concurrency: number;
  /** Cooldown rate limit atau kuota jendela habis: menambah staf tidak membantu. */
  blocked: boolean;
}

const HIRE_COOLDOWN_MS = 10 * 60_000;
const NOTICE_COOLDOWN_MS = 30 * 60_000;

/**
 * Aturan HRD (deterministik, bukan LLM): tambah staf hanya bila ada task siap kerja yang menunggu
 * lebih lama dari ambang, semua staf role itu sedang sibuk, dan runtime-nya masih punya slot.
 * Menambah staf di runtime yang slot-nya penuh tidak mempercepat apa pun (DESIGN.md §26).
 * Di bawah batas → rekrut otomatis; di atas batas (atau mode "ask") → minta persetujuan Owner.
 */
export async function reviewStaffing(ctx: OfficeContext, load: (id: RuntimeId) => RuntimeLoad, now = new Date()) {
  const settings = await getAllSettings(ctx.db);
  const threshold = new Date(now.getTime() - settings.hire_wait_seconds * 1000);
  const waiting = (
    await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'queued'), lte(tasks.queuedAt, threshold)))
  ).filter((t) => t.requiredRoleId && (!t.notBefore || t.notBefore <= now));
  if (waiting.length === 0) return;

  const byRole = new Map<string, typeof waiting>();
  for (const t of waiting) byRole.set(t.requiredRoleId!, [...(byRole.get(t.requiredRoleId!) ?? []), t]);

  const running = await ctx.db.select({ a: tasks.assignedAgentId }).from(tasks).where(eq(tasks.status, 'running'));
  const busy = new Set(running.map((r) => r.a));

  for (const [roleId, queue] of byRole) {
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) continue;
    const staff = await ctx.db.select().from(agents).where(and(eq(agents.roleId, roleId), ne(agents.status, 'inactive')));
    const active = staff.filter((a) => a.status === 'active');
    if (active.length === 0 || active.some((a) => !busy.has(a.id))) continue; // masih ada yang menganggur

    // Runtime tujuan: runtime staf sekarang; bila slot-nya penuh, coba runtime lain yang mampu.
    const needs = queue.flatMap((t) => kindSpec(t.kind).requires);
    const capable = (id: RuntimeId) => needs.every((cap) => ctx.runtimes.get(id)?.capabilities.has(cap));
    const current = active[0]!.runtime as RuntimeId;
    const hasSlot = (id: RuntimeId) => {
      const l = load(effectiveRuntime(ctx, id));
      return !l.blocked && l.inflight < l.concurrency;
    };
    let runtime: RuntimeId | null = hasSlot(current) ? current : null;
    if (!runtime) {
      runtime = ([...ctx.runtimes.keys()] as RuntimeId[]).find((id) => id !== 'fake' && id !== current && capable(id) && hasSlot(id)) ?? null;
    }
    if (!runtime) {
      await noticeCapacityLimited(ctx, roleId, role.name, queue.length, now);
      continue;
    }

    const recent = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.roleId, roleId), gt(agents.createdAt, new Date(now.getTime() - HIRE_COOLDOWN_MS))));
    if (recent.length > 0) continue;

    const reason = `Antrean ${role.name}: ${queue.length} task menunggu lebih dari ${settings.hire_wait_seconds} detik dan semua staf sibuk`;
    if (settings.auto_hire === 'auto' && staff.length < settings.max_staff_per_role) {
      await withTx(ctx, (tx, emit) => hireAgent(ctx, tx, emit, { roleId, runtime: runtime!, actor: 'orchestrator', createdBy: 'hrd:auto', reason }));
      continue;
    }
    if (!ctx.gateway || (await hasPendingHire(ctx, roleId))) continue;
    await ctx.gateway.systemRequest(
      'propose_org_change',
      { type: 'hire', role_id: roleId, runtime, reason: `${reason}. Staf saat ini ${staff.length}, batas otomatis ${settings.max_staff_per_role}.` },
      `Aturan HRD meminta menambah staf ${role.name}`,
    );
  }
}

async function hasPendingHire(ctx: OfficeContext, roleId: string) {
  const pending = await ctx.db.select().from(approvals).where(and(eq(approvals.status, 'pending'), eq(approvals.toolId, 'propose_org_change')));
  return pending.some((p) => (p.args as { type?: string; role_id?: string }).type === 'hire' && (p.args as { role_id?: string }).role_id === roleId);
}

/** Dicatat sekali per 30 menit per role agar tidak membanjiri aktivitas. */
async function noticeCapacityLimited(ctx: OfficeContext, roleId: string, roleName: string, waiting: number, now: Date) {
  const recent = await ctx.db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.type, 'staffing.capacity_limited'), eq(events.entityId, roleId), gt(events.createdAt, new Date(now.getTime() - NOTICE_COOLDOWN_MS))))
    .limit(1);
  if (recent.length > 0) return;
  await withTx(ctx, async (_tx, emit) =>
    emit({
      type: 'staffing.capacity_limited',
      entityType: 'role',
      entityId: roleId,
      actor: 'orchestrator',
      payload: { role: roleName, waiting, note: 'Slot runtime penuh; staf tambahan tidak mempercepat. Naikkan batas paralel atau pasang provider lain.' },
    }),
  );
}

