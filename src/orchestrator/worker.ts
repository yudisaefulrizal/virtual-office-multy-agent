import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, sql } from 'drizzle-orm';
import { buildPrompts, repairPrompt } from '../agents/prompt';
import { jsonSchemaFor, kindSpec } from '../agents/schemas';
import { agentSessions, agents, artifacts, objectives, roles, tasks } from '../db/schema';
import { Task, type TaskStatus } from '../domain';
import type { AgentRuntime, NativeToolPolicy, RunRequest, RunResult, RuntimeId } from '../runtimes/runtime';
import { rowsOf, type Tx } from '../db/client';
import { type Emit, type OfficeContext, withTx } from './context';
import { onTaskFinished } from './office';
import { scanOutDir } from './artifacts';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 30 * 60_000;

export interface WorkerOptions {
  pollMs?: number;
  /** Jeda sebelum retry ke-n = retryBackoffMs × n. */
  retryBackoffMs?: number;
}

type TaskRow = typeof tasks.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/**
 * Menjalankan task dari antrean. Satu proses; antrean memakai
 * SELECT … FOR UPDATE SKIP LOCKED di Postgres (DESIGN.md §8).
 */
export class Worker {
  private inflight = new Map<string, { ctl: AbortController; done: Promise<void> }>();
  private cooldownUntil = new Map<RuntimeId, Date>();
  private quotaBlocked = new Set<RuntimeId>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  private runtimeOf = new Map<string, RuntimeId>();
  private pollMs: number;
  private retryBackoffMs: number;

  constructor(
    private ctx: OfficeContext,
    opts: WorkerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.retryBackoffMs = opts.retryBackoffMs ?? 30_000;
  }

  async start() {
    await this.recoverOrphans(true);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    for (const { ctl } of this.inflight.values()) ctl.abort();
    await Promise.allSettled([...this.inflight.values()].map((f) => f.done));
  }

  /** Status runtime untuk UI kantor. */
  runtimeState(id: RuntimeId) {
    const until = this.cooldownUntil.get(id);
    return {
      inflight: this.inflightFor(id),
      cooldownUntil: until && until > new Date() ? until : null,
      quotaBlocked: this.quotaBlocked.has(id),
    };
  }

  /** Hentikan task: sesi berjalan di-abort; task di antrean langsung dibatalkan. */
  async cancel(taskId: string) {
    const f = this.inflight.get(taskId);
    if (f) {
      f.ctl.abort();
      await f.done;
      return true;
    }
    return withTx(this.ctx, async (tx, emit) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      if (!t || !Task.can(t.status as TaskStatus, 'cancelled')) return false;
      await tx.update(tasks).set({ status: 'cancelled', completedAt: new Date() }).where(eq(tasks.id, taskId));
      emit({ type: 'task.cancelled', entityType: 'task', entityId: taskId, objectiveId: t.objectiveId, actor: 'owner' });
      await onTaskFinished(tx, emit, t);
      return true;
    });
  }

  /** Untuk test: jalankan sampai tidak ada task yang bisa di-claim dan tidak ada yang berjalan. */
  async drain() {
    for (;;) {
      const started = await this.tick();
      const pending = [...this.inflight.values()].map((f) => f.done);
      if (started === 0 && pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      await this.recoverOrphans(false);
      for (const [id, runtime] of this.ctx.runtimes) {
        while (await this.hasCapacity(id)) {
          const taskId = await this.claim(id);
          if (!taskId) break;
          started++;
          const ctl = new AbortController();
          const done = this.execute(taskId, runtime, ctl.signal)
            .catch((err) => console.error(`[worker] task ${taskId}:`, err))
            .finally(() => this.inflight.delete(taskId));
          this.inflight.set(taskId, { ctl, done });
        }
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  private inflightFor(id: RuntimeId) {
    // Semua task in-flight memakai runtime efektif yang sama jika forceRuntime aktif.
    return [...this.inflight.keys()].filter((k) => this.runtimeOf.get(k) === id).length;
  }

  private async hasCapacity(id: RuntimeId) {
    const limits = this.ctx.limits.get(id);
    if (!limits) return false;
    const until = this.cooldownUntil.get(id);
    if (until && until > new Date()) return false;
    if (this.inflightFor(id) >= limits.concurrency) return false;

    if (limits.maxRunsPerWindow && limits.windowHours) {
      const since = new Date(Date.now() - limits.windowHours * 3600_000);
      const [row] = await this.ctx.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(agentSessions)
        .where(and(eq(agentSessions.runtime, id), gt(agentSessions.startedAt, since)));
      const blocked = (row?.n ?? 0) >= limits.maxRunsPerWindow;
      if (blocked && !this.quotaBlocked.has(id)) {
        this.quotaBlocked.add(id);
        await withTx(this.ctx, async (_tx, emit) =>
          emit({ type: 'runtime.quota_reached', entityType: 'runtime', entityId: id, actor: 'orchestrator', payload: { used: row?.n, max: limits.maxRunsPerWindow, windowHours: limits.windowHours } }),
        );
      } else if (!blocked && this.quotaBlocked.delete(id)) {
        await withTx(this.ctx, async (_tx, emit) =>
          emit({ type: 'runtime.quota_available', entityType: 'runtime', entityId: id, actor: 'orchestrator' }),
        );
      }
      if (blocked) return false;
    }
    return true;
  }

  private async claim(runtimeId: RuntimeId): Promise<string | null> {
    const force = this.ctx.forceRuntime;
    if (force && force !== runtimeId) return null;
    const runtimeFilter = force ? sql`true` : sql`a.runtime = ${runtimeId}`;
    // MySQL tidak punya UPDATE … RETURNING: kunci baris dengan SKIP LOCKED, lalu update di transaksi yang sama.
    const row = await this.ctx.db.transaction(async (tx) => {
      const now = new Date();
      const [picked] = rowsOf<{ id: string; objective_id: string; assigned_agent_id: string }>(
        await tx.execute(sql`
          select t.id, t.objective_id, t.assigned_agent_id from tasks t join agents a on a.id = t.assigned_agent_id
          where t.status = 'queued' and a.status = 'active' and ${runtimeFilter}
            and (t.not_before is null or t.not_before <= ${now})
          order by t.created_at
          limit 1
          for update of t skip locked`),
      );
      if (!picked) return null;
      await tx
        .update(tasks)
        .set({ status: 'running', attempt: sql`${tasks.attempt} + 1`, startedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS), notBefore: null })
        .where(eq(tasks.id, picked.id));
      return picked;
    });
    if (!row) return null;
    this.runtimeOf.set(row.id, runtimeId);
    await withTx(this.ctx, async (_tx, emit) =>
      emit({ type: 'task.started', entityType: 'task', entityId: row.id, objectiveId: row.objective_id, actor: `agent:${row.assigned_agent_id}` }),
    );
    return row.id;
  }

  /**
   * Task `running` tanpa pemilik di proses ini dan lease-nya habis (mis. proses crash)
   * dikembalikan ke antrean. Saat startup, semua task running adalah yatim.
   */
  async recoverOrphans(atStartup: boolean) {
    const running = await this.ctx.db.select().from(tasks).where(eq(tasks.status, 'running'));
    const now = new Date();
    for (const t of running) {
      if (this.inflight.has(t.id)) continue;
      if (!atStartup && t.leaseUntil && t.leaseUntil > now) continue;
      await withTx(this.ctx, async (tx, emit) => {
        await tx
          .update(agentSessions)
          .set({ status: 'aborted', error: 'Proses orchestrator berhenti saat sesi berjalan', endedAt: now })
          .where(and(eq(agentSessions.taskId, t.id), eq(agentSessions.status, 'running')));
        await this.failOrRetry(tx, emit, t, 'Sesi terputus (orchestrator restart atau lease habis)');
      });
    }
  }

  private async execute(taskId: string, runtime: AgentRuntime, signal: AbortSignal) {
    const heartbeat = setInterval(() => {
      void this.ctx.db
        .update(tasks)
        .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')));
    }, HEARTBEAT_MS);
    try {
      const [row] = await this.ctx.db
        .select({ task: tasks, agent: agents, role: roles, objective: objectives })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.assignedAgentId))
        .innerJoin(roles, eq(roles.id, agents.roleId))
        .innerJoin(objectives, eq(objectives.id, tasks.objectiveId))
        .where(eq(tasks.id, taskId));
      if (!row) throw new Error(`Task ${taskId} tidak ditemukan`);
      const { task, agent, role, objective } = row;

      const spec = kindSpec(task.kind);
      const workDir = path.join(this.ctx.workspacesDir, agent.workspacePath, 'tasks', task.id);
      await mkdir(path.join(workDir, 'out'), { recursive: true });
      const { systemPrompt, prompt } = buildPrompts({ agent, role, task, objective });
      const base = {
        workDir,
        systemPrompt,
        outputSchema: jsonSchemaFor(task.kind),
        nativeTools: role.nativeTools as NativeToolPolicy,
        model: agent.model ?? undefined,
        timeoutMs: task.timeoutMs,
      };

      let { res, sessionId } = await this.session(task, agent, runtime, { ...base, prompt }, 'run', signal);
      let parsed = res.status === 'ok' ? spec.schema.safeParse(res.output) : undefined;

      if (parsed && !parsed.success && !signal.aborted) {
        await this.ctx.db.update(agentSessions).set({ status: 'invalid_output', error: parsed.error.message.slice(0, 2000) }).where(eq(agentSessions.id, sessionId));
        ({ res, sessionId } = await this.session(
          task, agent, runtime,
          { ...base, prompt: repairPrompt(parsed.error.message), resumeSessionId: res.externalSessionId },
          'repair', signal,
        ));
        parsed = res.status === 'ok' ? spec.schema.safeParse(res.output) : undefined;
      }

      if (res.status === 'aborted' || signal.aborted) return await this.cancelled(task);
      if (res.status === 'rate_limited') return await this.deferred(task, runtime.id, res);
      if (parsed?.success) return await this.completed(task, workDir, parsed.data, res, sessionId);

      const error =
        res.status === 'ok' ? `Output tidak valid setelah repair: ${parsed && !parsed.success ? parsed.error.message : ''}` : res.error ?? res.status;
      await withTx(this.ctx, (tx, emit) => this.failOrRetry(tx, emit, task, error.slice(0, 2000)));
    } finally {
      clearInterval(heartbeat);
      this.runtimeOf.delete(taskId);
    }
  }

  /** Satu invocation runtime = satu baris agent_sessions. */
  private async session(
    task: TaskRow,
    agent: AgentRow,
    runtime: AgentRuntime,
    req: Omit<RunRequest, 'sessionId' | 'logPath'>,
    purpose: 'run' | 'repair',
    signal: AbortSignal,
  ): Promise<{ res: RunResult; sessionId: string }> {
    const sessionId = randomUUID();
    const logRel = path.join(agent.workspacePath, 'sessions', `${sessionId}.log`);
    const limits = this.ctx.limits.get(runtime.id);
    await withTx(this.ctx, async (tx, emit) => {
      await tx.insert(agentSessions).values({
        id: sessionId,
        agentId: agent.id,
        taskId: task.id,
        runtime: runtime.id,
        model: req.model,
        attempt: task.attempt,
        purpose,
        status: 'running',
        logPath: logRel,
      });
      emit({ type: 'session.started', entityType: 'session', entityId: sessionId, objectiveId: task.objectiveId, actor: `agent:${agent.id}`, payload: { taskId: task.id, runtime: runtime.id, purpose } });
    });

    let res: RunResult;
    try {
      res = await runtime.run({ ...req, sessionId, logPath: path.join(this.ctx.workspacesDir, logRel) }, signal);
    } catch (err) {
      res = { status: 'error', externalSessionId: sessionId, output: null, error: String(err), usage: {}, durationMs: 0 };
    }

    await withTx(this.ctx, async (tx, emit) => {
      await tx
        .update(agentSessions)
        .set({
          status: res.status,
          externalSessionId: res.externalSessionId,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          costUsdMicros: res.usage.costUsdMicros,
          costKind: limits?.costKind,
          error: res.error,
          endedAt: new Date(),
        })
        .where(eq(agentSessions.id, sessionId));
      emit({ type: 'session.ended', entityType: 'session', entityId: sessionId, objectiveId: task.objectiveId, actor: `agent:${agent.id}`, payload: { taskId: task.id, status: res.status, durationMs: res.durationMs } });
    });
    return { res, sessionId };
  }

  private async completed(task: TaskRow, workDir: string, result: unknown, res: RunResult, sessionId: string) {
    const files = await scanOutDir(this.ctx.workspacesDir, path.join(workDir, 'out'));
    await withTx(this.ctx, async (tx, emit) => {
      Task.assert('running', 'completed');
      await tx
        .update(tasks)
        .set({ status: 'completed', result: result as object, error: null, leaseUntil: null, completedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'running')));
      for (const f of files) {
        const id = randomUUID();
        await tx.insert(artifacts).values({ id, taskId: task.id, sessionId, ...f });
        emit({ type: 'artifact.created', entityType: 'artifact', entityId: id, objectiveId: task.objectiveId, actor: `agent:${task.assignedAgentId}`, payload: { path: f.path, taskId: task.id } });
      }
      emit({ type: 'task.completed', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: `agent:${task.assignedAgentId}`, payload: { artifacts: files.length, durationMs: res.durationMs } });
      await onTaskFinished(tx, emit, task);
    });
  }

  private async deferred(task: TaskRow, runtimeId: RuntimeId, res: RunResult) {
    const until = res.retryAt && res.retryAt > new Date() ? res.retryAt : new Date(Date.now() + RATE_LIMIT_FALLBACK_MS);
    this.cooldownUntil.set(runtimeId, until);
    await withTx(this.ctx, async (tx, emit) => {
      Task.assert('running', 'queued');
      // Rate limit bukan kegagalan task: attempt dikembalikan.
      await tx
        .update(tasks)
        .set({ status: 'queued', attempt: Math.max(0, task.attempt - 1), notBefore: until, leaseUntil: null, error: res.error ?? 'rate limited' })
        .where(eq(tasks.id, task.id));
      emit({ type: 'runtime.rate_limited', entityType: 'runtime', entityId: runtimeId, actor: 'orchestrator', payload: { until: until.toISOString() } });
      emit({ type: 'task.deferred', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { until: until.toISOString() } });
    });
  }

  private async cancelled(task: TaskRow) {
    await withTx(this.ctx, async (tx, emit) => {
      Task.assert('running', 'cancelled');
      await tx.update(tasks).set({ status: 'cancelled', leaseUntil: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
      emit({ type: 'task.cancelled', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'owner' });
      await onTaskFinished(tx, emit, task);
    });
  }

  private async failOrRetry(tx: Tx, emit: Emit, task: TaskRow, error: string) {
    if (task.attempt < task.maxAttempts) {
      Task.assert('running', 'queued');
      const notBefore = new Date(Date.now() + this.retryBackoffMs * task.attempt);
      await tx.update(tasks).set({ status: 'queued', error, leaseUntil: null, notBefore }).where(eq(tasks.id, task.id));
      emit({ type: 'task.retry_scheduled', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { attempt: task.attempt, error, notBefore: notBefore.toISOString() } });
    } else {
      Task.assert('running', 'failed');
      await tx.update(tasks).set({ status: 'failed', error, leaseUntil: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
      emit({ type: 'task.failed', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { attempt: task.attempt, error } });
      await onTaskFinished(tx, emit, task);
    }
  }
}
