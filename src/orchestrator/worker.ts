import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { buildPrompts, repairPrompt, type DependencyContext } from '../agents/prompt';
import { jsonSchemaFor, kindSpec, resultDigest } from '../agents/schemas';
import { agentSessions, agents, artifacts, objectives, roles, taskDependencies, tasks } from '../db/schema';
import { Task, type TaskStatus } from '../domain';
import type { AgentRuntime, NativeToolPolicy, RunRequest, RunResult, RuntimeId } from '../runtimes/runtime';
import { rowsOf, type Tx } from '../db/client';
import { type Emit, type OfficeContext, effectiveRuntime, withTx } from './context';
import { knowledgePromptSection, searchKnowledge } from './knowledge';
import { spentUsdMicros } from './budget';
import { runDueSchedules } from './scheduler';
import { collectDueMetrics } from './metrics';
import { onTaskAborted, onTaskCompleted } from './office';
import { loadPlannableRoles } from './org';
import { reviewStaffing } from './staffing';
import { companyBrief, reviewCompany } from './company';
import { scanOutDir } from './artifacts';
import { quotaUsage } from './quota';

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 30 * 60_000;
const SCHEDULE_CHECK_MS = 15_000;

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
  /**
   * Batas paralel efektif per runtime. Turun separuh saat kena rate limit dan naik satu per run
   * yang berhasil, sampai batas konfigurasi: paralel secukupnya, bukan angka tetap.
   */
  private caps = new Map<RuntimeId, number>();
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
      concurrency: this.capFor(id),
    };
  }

  private capFor(id: RuntimeId) {
    const max = this.ctx.limits.get(id)?.concurrency ?? 1;
    return Math.min(max, this.caps.get(id) ?? max);
  }

  private adjustCap(id: RuntimeId, outcome: 'rate_limited' | 'ok') {
    const max = this.ctx.limits.get(id)?.concurrency ?? 1;
    const cur = this.capFor(id);
    this.caps.set(id, outcome === 'rate_limited' ? Math.max(1, Math.floor(cur / 2)) : Math.min(max, cur + 1));
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
      await onTaskAborted(tx, emit, t);
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

  private lastScheduleCheck = 0;

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      await this.recoverOrphans(false);
      if (Date.now() - this.lastScheduleCheck >= SCHEDULE_CHECK_MS) {
        this.lastScheduleCheck = Date.now();
        await runDueSchedules(this.ctx).catch((err) => console.error('[scheduler]', err));
        // Jaringan ke NC-WA tidak boleh menahan antrean task: jalankan di latar.
        void collectDueMetrics(this.ctx).catch((err) => console.error('[metrics]', err));
        await reviewCompany(this.ctx).catch((err) => console.error('[company]', err));
        await reviewStaffing(this.ctx, (id) => {
          const st = this.runtimeState(id);
          return { inflight: st.inflight, concurrency: st.concurrency, blocked: !!st.cooldownUntil || st.quotaBlocked };
        }).catch((err) => console.error('[staffing]', err));
      }
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
    if (this.inflightFor(id) >= this.capFor(id)) return false;

    const quota = await quotaUsage(this.ctx, id);
    if (quota) {
      const blocked = quota.used >= quota.max;
      if (blocked && !this.quotaBlocked.has(id)) {
        this.quotaBlocked.add(id);
        await withTx(this.ctx, async (_tx, emit) =>
          emit({ type: 'runtime.quota_reached', entityType: 'runtime', entityId: id, actor: 'orchestrator', payload: { used: quota.used, max: quota.max, windowHours: quota.windowHours } }),
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

  /**
   * Ambil task berikutnya untuk runtime ini. Satu karyawan hanya mengerjakan satu task pada satu
   * waktu, jadi jumlah staf = kapasitas paralel yang sebenarnya. Agent dipilih saat diambil: task
   * dikerjakan oleh staf role yang sedang menganggur (pilihan awal diutamakan).
   */
  private async claim(runtimeId: RuntimeId): Promise<string | null> {
    const ctx = this.ctx;
    const force = ctx.forceRuntime;
    if (force && force !== runtimeId) return null;
    const runtime = ctx.runtimes.get(runtimeId);
    if (!runtime) return null;

    // MySQL tidak punya UPDATE … RETURNING: kunci baris dengan SKIP LOCKED, lalu update di transaksi yang sama.
    const row = await ctx.db.transaction(async (tx) => {
      const now = new Date();
      const candidates = rowsOf<{ id: string; objective_id: string; kind: string; required_role_id: string | null; assigned_agent_id: string | null }>(
        await tx.execute(sql`
          select t.id, t.objective_id, t.kind, t.required_role_id, t.assigned_agent_id from tasks t
          where t.status = 'queued' and (t.not_before is null or t.not_before <= ${now})
          order by t.created_at
          limit 25
          for update skip locked`),
      );
      if (candidates.length === 0) return null;
      const busy = new Set(
        rowsOf<{ a: string }>(await tx.execute(sql`select distinct assigned_agent_id as a from tasks where status = 'running' and assigned_agent_id is not null`)).map((r) => r.a),
      );
      const staff = await tx.select().from(agents).where(eq(agents.status, 'active'));

      for (const c of candidates) {
        if (!kindSpec(c.kind).requires.every((cap) => runtime.capabilities.has(cap))) continue;
        const eligible = staff.filter(
          (a) => !busy.has(a.id) && effectiveRuntime(ctx, a.runtime) === runtimeId && (c.required_role_id ? a.roleId === c.required_role_id : a.id === c.assigned_agent_id),
        );
        const agent = eligible.find((a) => a.id === c.assigned_agent_id) ?? eligible[0];
        if (!agent) continue;
        await tx
          .update(tasks)
          .set({
            status: 'running',
            assignedAgentId: agent.id,
            attempt: sql`${tasks.attempt} + 1`,
            startedAt: now,
            leaseUntil: new Date(now.getTime() + LEASE_MS),
            notBefore: null,
          })
          .where(eq(tasks.id, c.id));
        return { id: c.id, objective_id: c.objective_id, assigned_agent_id: agent.id };
      }
      return null;
    });
    if (!row) return null;
    this.runtimeOf.set(row.id, runtimeId);
    await withTx(ctx, async (_tx, emit) =>
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

      // Budget objective (biaya API nyata). Melewati batas → task ditunda, Owner diberi tahu.
      if (objective.budgetUsdMicros != null) {
        const spent = await spentUsdMicros(this.ctx.db, objective.id);
        if (spent >= objective.budgetUsdMicros) return await this.budgetBlocked(task, spent, objective.budgetUsdMicros);
      }

      const spec = kindSpec(task.kind);
      const workDir = path.join(this.ctx.workspacesDir, agent.workspacePath, 'tasks', task.id);
      await mkdir(path.join(workDir, 'out'), { recursive: true });
      const dependencies = await this.prepareContext(task.id, workDir);
      // Review menilai hasil kerja, bukan fakta baru; knowledge tidak perlu disertakan.
      const relevant = task.kind === 'review' ? [] : await searchKnowledge(this.ctx.db, `${objective.title} ${task.title} ${task.instructions}`);
      const knowledge = knowledgePromptSection(relevant, task.kind === 'research');
      const { systemPrompt, prompt } = buildPrompts({ agent, role, task, objective, dependencies, knowledge, company: (await companyBrief(this.ctx.db)) ?? undefined });
      const base = {
        workDir,
        systemPrompt,
        outputSchema: jsonSchemaFor(task.kind),
        nativeTools: role.nativeTools as NativeToolPolicy,
        model: agent.model ?? undefined,
        timeoutMs: task.timeoutMs,
      };

      // Schema dulu, lalu validasi semantik (mis. DAG rencana). Keduanya memicu satu kali repair.
      const checkCtx = task.kind === 'planning' ? { plannable: (await loadPlannableRoles(this.ctx.db)).map((r) => r.id) } : undefined;
      const validate = (output: unknown): { ok: true; data: unknown } | { ok: false; error: string } => {
        const p = spec.schema.safeParse(output);
        if (!p.success) return { ok: false, error: p.error.message };
        const problem = spec.check?.(p.data, task.input, checkCtx);
        return problem ? { ok: false, error: problem } : { ok: true, data: p.data };
      };

      let { res, sessionId } = await this.session(task, agent, runtime, { ...base, prompt }, 'run', signal);
      let checked = res.status === 'ok' ? validate(res.output) : undefined;

      if (checked && !checked.ok && !signal.aborted) {
        await this.ctx.db.update(agentSessions).set({ status: 'invalid_output', error: checked.error.slice(0, 2000) }).where(eq(agentSessions.id, sessionId));
        ({ res, sessionId } = await this.session(
          task, agent, runtime,
          { ...base, prompt: repairPrompt(checked.error), resumeSessionId: res.externalSessionId },
          'repair', signal,
        ));
        checked = res.status === 'ok' ? validate(res.output) : undefined;
      }

      if (res.status === 'aborted' || signal.aborted) return await this.cancelled(task);
      if (res.status === 'rate_limited') {
        this.adjustCap(runtime.id, 'rate_limited');
        return await this.deferred(task, runtime.id, res);
      }
      if (res.status === 'ok') this.adjustCap(runtime.id, 'ok');
      if (checked?.ok) return await this.completed(task, workDir, checked.data, res, sessionId);

      const error = res.status === 'ok' ? `Output tidak valid setelah repair: ${checked && !checked.ok ? checked.error : ''}` : res.error ?? res.status;
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

    const gateway = runtime.capabilities.has('tools') ? this.ctx.gateway : undefined;
    const token = gateway?.issueToken({
      agentId: agent.id,
      agentName: agent.name,
      roleId: agent.roleId,
      taskId: task.id,
      sessionId,
      objectiveId: task.objectiveId,
    });
    let res: RunResult;
    try {
      res = await runtime.run(
        { ...req, sessionId, logPath: path.join(this.ctx.workspacesDir, logRel), mcpServers: token ? gateway!.mcpServers(token) : undefined },
        signal,
      );
    } catch (err) {
      res = { status: 'error', externalSessionId: sessionId, output: null, error: String(err), usage: {}, durationMs: 0 };
    } finally {
      if (token) gateway!.revokeToken(token);
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
      emit({ type: 'task.completed', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: `agent:${task.assignedAgentId}`, payload: { artifacts: files.length, durationMs: res.durationMs, kind: task.kind } });
      await onTaskCompleted(this.ctx, tx, emit, task, result);
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
        .set({ status: 'queued', queuedAt: new Date(), attempt: Math.max(0, task.attempt - 1), notBefore: until, leaseUntil: null, error: res.error ?? 'rate limited' })
        .where(eq(tasks.id, task.id));
      emit({ type: 'runtime.rate_limited', entityType: 'runtime', entityId: runtimeId, actor: 'orchestrator', payload: { until: until.toISOString() } });
      emit({ type: 'task.deferred', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { until: until.toISOString() } });
    });
  }

  private async budgetBlocked(task: TaskRow, spent: number, budget: number) {
    const notBefore = new Date(Date.now() + 3600_000);
    await withTx(this.ctx, async (tx, emit) => {
      Task.assert('running', 'queued');
      await tx
        .update(tasks)
        .set({ status: 'queued', queuedAt: new Date(), attempt: Math.max(0, task.attempt - 1), notBefore, leaseUntil: null, error: 'Budget objective habis' })
        .where(eq(tasks.id, task.id));
      emit({ type: 'budget.exceeded', entityType: 'objective', entityId: task.objectiveId, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { spentUsdMicros: spent, budgetUsdMicros: budget } });
    });
  }

  private async cancelled(task: TaskRow) {
    await withTx(this.ctx, async (tx, emit) => {
      Task.assert('running', 'cancelled');
      await tx.update(tasks).set({ status: 'cancelled', leaseUntil: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
      emit({ type: 'task.cancelled', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'owner' });
      await onTaskAborted(tx, emit, task);
    });
  }

  /**
   * Salin artifact dari task dependency ke context/<plan key>/ milik task ini.
   * Perlu karena --restricted membatasi agent ke working directory-nya sendiri.
   */
  private async prepareContext(taskId: string, workDir: string): Promise<DependencyContext[]> {
    const deps = await this.ctx.db
      .select({ task: tasks, agentName: agents.name })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
      .leftJoin(agents, eq(agents.id, tasks.assignedAgentId))
      .where(eq(taskDependencies.taskId, taskId));
    if (deps.length === 0) return [];
    const files = await this.ctx.db.select().from(artifacts).where(inArray(artifacts.taskId, deps.map((d) => d.task.id)));

    const out: DependencyContext[] = [];
    for (const { task: dep, agentName } of deps) {
      const key = dep.planKey ?? dep.id.slice(0, 8);
      const copied: string[] = [];
      for (const f of files.filter((a) => a.taskId === dep.id)) {
        const marker = `/tasks/${dep.id}/`;
        const i = f.path.indexOf(marker);
        if (i === -1) continue;
        const rel = path.join('context', key, f.path.slice(i + marker.length));
        await mkdir(path.dirname(path.join(workDir, rel)), { recursive: true });
        await copyFile(path.join(this.ctx.workspacesDir, f.path), path.join(workDir, rel));
        copied.push(rel);
      }
      out.push({
        key,
        title: dep.title,
        agentName: agentName ?? 'Agent',
        summary: resultDigest(dep.kind, dep.result),
        files: copied,
      });
    }
    return out;
  }

  private async failOrRetry(tx: Tx, emit: Emit, task: TaskRow, error: string) {
    if (task.attempt < task.maxAttempts) {
      Task.assert('running', 'queued');
      const notBefore = new Date(Date.now() + this.retryBackoffMs * task.attempt);
      await tx.update(tasks).set({ status: 'queued', queuedAt: new Date(), error, leaseUntil: null, notBefore }).where(eq(tasks.id, task.id));
      emit({ type: 'task.retry_scheduled', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { attempt: task.attempt, error, notBefore: notBefore.toISOString() } });
    } else {
      Task.assert('running', 'failed');
      await tx.update(tasks).set({ status: 'failed', error, leaseUntil: null, completedAt: new Date() }).where(eq(tasks.id, task.id));
      emit({ type: 'task.failed', entityType: 'task', entityId: task.id, objectiveId: task.objectiveId, actor: 'orchestrator', payload: { attempt: task.attempt, error } });
      await onTaskAborted(tx, emit, task);
    }
  }
}
