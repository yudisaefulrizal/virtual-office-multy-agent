import { rm } from 'node:fs/promises';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { agentSessions, approvals, artifacts, decisions, events, objectives, projects, schedules, taskDependencies, tasks, toolExecutions } from '../db/schema';
import { UserError } from '../domain';
import { type OfficeContext, withTx } from './context';

const DELETABLE = ['completed', 'failed', 'cancelled'];

/**
 * Hapus objective yang sudah selesai beserta seluruh jejaknya (task, sesi, artifact, keputusan,
 * persetujuan, event) dan folder kerja task-nya. Objective yang masih berjalan tidak boleh dihapus.
 * Knowledge organisasi tidak ikut terhapus: itu milik organisasi, bukan milik satu objective.
 */
export async function deleteObjective(ctx: OfficeContext, objectiveId: string) {
  const dirs: string[] = [];
  await withTx(ctx, async (tx, emit) => {
    const [obj] = await tx.select().from(objectives).where(eq(objectives.id, objectiveId));
    if (!obj) throw new UserError('Objective tidak ditemukan');
    if (!DELETABLE.includes(obj.status)) throw new UserError('Objective masih berjalan. Batalkan dulu sebelum menghapus.');

    const rows = await tx.select().from(tasks).where(eq(tasks.objectiveId, objectiveId));
    const ids = rows.map((t) => t.id);
    if (ids.length) {
      const sessions = await tx.select().from(agentSessions).where(inArray(agentSessions.taskId, ids));
      for (const t of rows) if (t.assignedAgentId) dirs.push(path.join(ctx.workspacesDir, 'agents', t.assignedAgentId, 'tasks', t.id));
      for (const s of sessions) if (s.logPath) dirs.push(path.resolve(ctx.workspacesDir, s.logPath));
      await tx.update(tasks).set({ retryOfTaskId: null }).where(inArray(tasks.id, ids));
      await tx.delete(toolExecutions).where(inArray(toolExecutions.taskId, ids));
      await tx.delete(artifacts).where(inArray(artifacts.taskId, ids));
      await tx.delete(agentSessions).where(inArray(agentSessions.taskId, ids));
      await tx.delete(taskDependencies).where(inArray(taskDependencies.taskId, ids));
      await tx.delete(taskDependencies).where(inArray(taskDependencies.dependsOn, ids));
    }
    await tx.delete(toolExecutions).where(eq(toolExecutions.objectiveId, objectiveId));
    await tx.delete(approvals).where(eq(approvals.objectiveId, objectiveId));
    await tx.delete(tasks).where(eq(tasks.objectiveId, objectiveId));
    await tx.delete(projects).where(eq(projects.objectiveId, objectiveId));
    await tx.delete(decisions).where(eq(decisions.objectiveId, objectiveId));
    await tx.delete(schedules).where(eq(schedules.objectiveId, objectiveId));
    await tx.delete(events).where(eq(events.objectiveId, objectiveId));
    await tx.delete(objectives).where(eq(objectives.id, objectiveId));
    emit({ type: 'objective.deleted', entityType: 'objective', entityId: objectiveId, actor: 'owner', payload: { title: obj.title } });
  });
  // File dihapus setelah transaksi berhasil, dan hanya di dalam folder workspaces.
  for (const d of dirs) {
    if (d.startsWith(ctx.workspacesDir + path.sep)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
}
