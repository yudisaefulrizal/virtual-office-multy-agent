import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { agentSessions, objectives, tasks } from '../db/schema';
import { type OfficeContext, withTx } from './context';

/**
 * Biaya nyata (API berbayar) yang sudah dipakai objective. Biaya estimasi dari
 * langganan Claude tidak dihitung: itu kuota, bukan uang (DESIGN.md §6.2).
 */
export async function spentUsdMicros(tx: Tx, objectiveId: string) {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${agentSessions.costUsdMicros}), 0)`.mapWith(Number) })
    .from(agentSessions)
    .innerJoin(tasks, eq(tasks.id, agentSessions.taskId))
    .where(and(eq(tasks.objectiveId, objectiveId), eq(agentSessions.costKind, 'actual')));
  return row?.total ?? 0;
}

/** Owner mengubah budget; task yang tertahan karena budget langsung bisa jalan lagi. */
export async function setObjectiveBudget(ctx: OfficeContext, objectiveId: string, budgetUsd: number | null) {
  await withTx(ctx, async (tx, emit) => {
    const micros = budgetUsd == null ? null : Math.round(budgetUsd * 1_000_000);
    await tx.update(objectives).set({ budgetUsdMicros: micros, updatedAt: new Date() }).where(eq(objectives.id, objectiveId));
    await tx
      .update(tasks)
      .set({ notBefore: null, error: null })
      .where(and(eq(tasks.objectiveId, objectiveId), eq(tasks.status, 'queued'), eq(tasks.error, 'Budget objective habis')));
    emit({ type: 'budget.updated', entityType: 'objective', entityId: objectiveId, objectiveId, actor: 'owner', payload: { budgetUsd } });
  });
}
