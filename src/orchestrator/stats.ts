import { eq, gt } from 'drizzle-orm';
import { agentSessions, agents, objectives, tasks, toolExecutions } from '../db/schema';
import type { OfficeContext } from './context';
import { getSetting } from './settings';

interface Bucket {
  sessions: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Biaya nyata (API berbayar). */
  actualUsdMicros: number;
  /** Estimasi dari CLI langganan: kuota, bukan uang. */
  estimateUsdMicros: number;
  durationMs: number;
}

const empty = (): Bucket => ({ sessions: 0, failures: 0, inputTokens: 0, outputTokens: 0, actualUsdMicros: 0, estimateUsdMicros: 0, durationMs: 0 });
const FAILED = new Set(['error', 'timeout', 'invalid_output', 'rate_limited']);

/**
 * Observability (DESIGN.md §25–26): pemakaian per hari, agent, objective, dan runtime.
 * Hari dihitung dalam zona waktu Owner (default WIB, UTC+7).
 */
export async function usageStats(ctx: OfficeContext, days = 14, tzOffsetHours = 7) {
  const db = ctx.db;
  const offset = tzOffsetHours * 3600_000;
  const dayOf = (d: Date) => new Date(d.getTime() + offset).toISOString().slice(0, 10);
  const now = new Date();
  const today = dayOf(now);
  const month = today.slice(0, 7);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - offset - (days - 1) * 86_400_000);
  const monthStart = new Date(Date.parse(`${month}-01T00:00:00Z`) - offset);
  const from = since < monthStart ? since : monthStart;

  const rows = await db
    .select({ s: agentSessions, agentName: agents.name, objectiveId: tasks.objectiveId, objectiveTitle: objectives.title })
    .from(agentSessions)
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .innerJoin(tasks, eq(tasks.id, agentSessions.taskId))
    .innerJoin(objectives, eq(objectives.id, tasks.objectiveId))
    .where(gt(agentSessions.startedAt, from));

  const add = (b: Bucket, s: (typeof rows)[number]['s']) => {
    b.sessions++;
    if (FAILED.has(s.status)) b.failures++;
    b.inputTokens += s.inputTokens ?? 0;
    b.outputTokens += s.outputTokens ?? 0;
    if (s.costKind === 'actual') b.actualUsdMicros += s.costUsdMicros ?? 0;
    else b.estimateUsdMicros += s.costUsdMicros ?? 0;
    if (s.endedAt) b.durationMs += s.endedAt.getTime() - s.startedAt.getTime();
  };

  const byDay = new Map<string, Bucket>();
  for (let i = days - 1; i >= 0; i--) byDay.set(dayOf(new Date(now.getTime() - i * 86_400_000)), empty());
  const todayB = empty();
  const monthB = empty();
  const byAgent = new Map<string, Bucket & { name: string }>();
  const byObjective = new Map<string, Bucket & { title: string }>();
  const byRuntime = new Map<string, Bucket & { runtime: string; model: string | null }>();

  for (const r of rows) {
    const d = dayOf(r.s.startedAt);
    if (d.startsWith(month)) add(monthB, r.s);
    if (d === today) add(todayB, r.s);
    if (r.s.startedAt < since) continue;
    const day = byDay.get(d);
    if (day) add(day, r.s);
    const a = byAgent.get(r.s.agentId) ?? { ...empty(), name: r.agentName };
    add(a, r.s);
    byAgent.set(r.s.agentId, a);
    const o = byObjective.get(r.objectiveId) ?? { ...empty(), title: r.objectiveTitle };
    add(o, r.s);
    byObjective.set(r.objectiveId, o);
    const key = `${r.s.runtime}|${r.s.model ?? ''}`;
    const rt = byRuntime.get(key) ?? { ...empty(), runtime: r.s.runtime, model: r.s.model };
    add(rt, r.s);
    byRuntime.set(key, rt);
  }

  const taskRows = await db.select({ status: tasks.status, completedAt: tasks.completedAt }).from(tasks).where(gt(tasks.completedAt, since));
  const tasksToday = { completed: 0, failed: 0 };
  for (const t of taskRows) {
    if (!t.completedAt || dayOf(t.completedAt) !== today) continue;
    if (t.status === 'completed') tasksToday.completed++;
    if (t.status === 'failed') tasksToday.failed++;
  }

  const toolRows = await db.select({ toolId: toolExecutions.toolId, status: toolExecutions.status }).from(toolExecutions).where(gt(toolExecutions.createdAt, since));
  const tools = new Map<string, Record<string, number>>();
  for (const t of toolRows) {
    const m = tools.get(t.toolId) ?? {};
    m[t.status] = (m[t.status] ?? 0) + 1;
    tools.set(t.toolId, m);
  }

  const sortByUse = <T extends Bucket>(xs: Iterable<T>) => [...xs].sort((a, b) => b.actualUsdMicros - a.actualUsdMicros || b.sessions - a.sessions);
  return {
    days,
    timezoneOffsetHours: tzOffsetHours,
    usdToIdr: await getSetting(db, 'usd_to_idr'),
    today: { ...todayB, tasks: tasksToday },
    month: monthB,
    byDay: [...byDay.entries()].map(([date, b]) => ({ date, ...b })),
    byAgent: sortByUse([...byAgent.entries()].map(([id, b]) => ({ id, ...b }))),
    byObjective: sortByUse([...byObjective.entries()].map(([id, b]) => ({ id, ...b }))),
    byRuntime: sortByUse(byRuntime.values()),
    tools: [...tools.entries()].map(([toolId, statuses]) => ({ toolId, statuses })),
  };
}
