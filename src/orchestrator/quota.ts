import { and, eq, gt, sql } from 'drizzle-orm';
import { agentSessions } from '../db/schema';
import type { RuntimeId } from '../runtimes/runtime';
import type { OfficeContext } from './context';
import { getAllSettings } from './settings';

export interface QuotaUsage {
  used: number;
  max: number;
  windowHours: number;
  /** Hitungan dimulai dari sini (jendela waktu atau reset oleh Owner, mana yang lebih baru). */
  since: Date;
}

/**
 * Pemakaian kuota run sebuah runtime. Batas dari Pengaturan (`claude_max_runs_per_window`:
 * -1 ikut .env, 0 tanpa batas) dan hitungan bisa direset Owner (`quota_counted_since`).
 * null = runtime ini tidak dibatasi.
 */
export async function quotaUsage(ctx: OfficeContext, id: RuntimeId): Promise<QuotaUsage | null> {
  const limits = ctx.limits.get(id);
  if (!limits?.windowHours) return null;
  let max = limits.maxRunsPerWindow ?? 0;
  let resetAt = 0;
  if (id === 'claude-cli') {
    const s = await getAllSettings(ctx.db);
    if (s.claude_max_runs_per_window >= 0) max = s.claude_max_runs_per_window;
    resetAt = s.quota_counted_since ? Date.parse(s.quota_counted_since) || 0 : 0;
  }
  if (!max) return null;
  const since = new Date(Math.max(Date.now() - limits.windowHours * 3600_000, resetAt));
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(agentSessions)
    .where(and(eq(agentSessions.runtime, id), gt(agentSessions.startedAt, since)));
  return { used: row?.n ?? 0, max, windowHours: limits.windowHours, since };
}
