import { getCompany } from '../orchestrator/company';
import { publishableAccount } from '../orchestrator/instagram';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { approvals, toolCredentials, toolExecutions } from '../db/schema';
import { UserError } from '../domain';
import { type OfficeContext, withTx } from '../orchestrator/context';
import { type Caller, allowedToolIds, toolById } from './tools';

const TOKEN_TTL_MS = 2 * 3600_000;

/**
 * Tool Gateway (DESIGN.md §19, lapis 2): agent memanggil tool lewat MCP dengan token
 * sesi. Gateway yang memeriksa izin, risiko, persetujuan, credential, dan audit.
 */
export class Gateway {
  private tokens = new Map<string, Caller & { expiresAt: number }>();

  constructor(
    private ctx: OfficeContext,
    /** URL dasar yang bisa dijangkau proses agent (mis. http://127.0.0.1:8070). */
    readonly baseUrl: string,
  ) {}

  issueToken(caller: Caller) {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, { ...caller, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  }

  revokeToken(token: string) {
    this.tokens.delete(token);
  }

  resolve(token: string | undefined): Caller | null {
    if (!token) return null;
    const c = this.tokens.get(token);
    if (!c) return null;
    if (c.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return c;
  }

  mcpServers(token: string) {
    return [{ name: 'vo', url: `${this.baseUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } }];
  }

  /** Satu pemanggilan tool dari agent. Selalu tercatat di tool_executions dan events. */
  async call(caller: Caller, toolId: string, rawArgs: unknown): Promise<{ ok: boolean; message: string; result?: unknown }> {
    const ctx = this.ctx;
    const tool = toolById(toolId);
    const base = {
      id: randomUUID(),
      toolId,
      agentId: caller.agentId,
      taskId: caller.taskId,
      sessionId: caller.sessionId,
      objectiveId: caller.objectiveId,
    };
    const actor = `agent:${caller.agentId}` as const;

    if (!tool || !allowedToolIds(caller.roleId).includes(toolId)) {
      await withTx(ctx, async (tx, emit) => {
        await tx.insert(toolExecutions).values({ ...base, args: (rawArgs ?? {}) as object, status: 'denied', error: 'Tidak diizinkan untuk role ini', finishedAt: new Date() });
        emit({ type: 'tool.denied', entityType: 'tool_execution', entityId: base.id, objectiveId: caller.objectiveId, actor, payload: { toolId, roleId: caller.roleId } });
      });
      return { ok: false, message: `Tool ${toolId} tidak diizinkan untuk role ${caller.roleId}.` };
    }

    const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
    if (!parsed.success) return { ok: false, message: `Argumen tidak valid: ${parsed.error.message}` };
    const args = parsed.data;

    if (tool.risk === 'high') {
      const approvalId = randomUUID();
      await withTx(ctx, async (tx, emit) => {
        await tx.insert(approvals).values({
          id: approvalId,
          kind: 'tool',
          status: 'pending',
          objectiveId: caller.objectiveId,
          taskId: caller.taskId,
          agentId: caller.agentId,
          toolId,
          args,
          reason: `${caller.agentName} meminta ${tool.title}`,
        });
        await tx.insert(toolExecutions).values({ ...base, approvalId, args, status: 'pending_approval' });
        emit({ type: 'approval.requested', entityType: 'approval', entityId: approvalId, objectiveId: caller.objectiveId, actor, payload: { toolId, title: tool.title } });
      });
      if (await this.autoApprovable(toolId)) {
        await this.approve(approvalId, 'Disetujui otomatis: perusahaan diizinkan Owner mempublikasikan sendiri.', 'orchestrator');
        return { ok: true, message: `${tool.title} disetujui otomatis sesuai kebijakan perusahaan dan sedang dijalankan sistem. Lanjutkan task tanpa menunggu.` };
      }
      return {
        ok: true,
        message: `${tool.title} membutuhkan persetujuan Owner. Permintaan tercatat (approval ${approvalId}) dan akan dijalankan sistem setelah disetujui. Lanjutkan task tanpa menunggu.`,
      };
    }

    return this.execute(base, tool.id, args, caller, null);
  }

  private async execute(
    base: { id: string; toolId: string; agentId: string | null; taskId: string | null; sessionId: string | null; objectiveId: string | null },
    toolId: string,
    args: Record<string, unknown>,
    caller: Caller | null,
    approvalId: string | null,
  ) {
    const tool = toolById(toolId)!;
    const actor = approvalId ? ('owner' as const) : (`agent:${base.agentId}` as const);
    try {
      const result = await tool.execute(this.ctx, args as never, caller ?? ({} as Caller));
      await withTx(this.ctx, async (tx, emit) => {
        if (approvalId) {
          await tx.update(toolExecutions).set({ status: 'executed', result: result as object, finishedAt: new Date() }).where(eq(toolExecutions.id, base.id));
        } else {
          await tx.insert(toolExecutions).values({ ...base, args, status: 'executed', result: result as object, finishedAt: new Date() });
        }
        emit({ type: 'tool.executed', entityType: 'tool_execution', entityId: base.id, objectiveId: base.objectiveId, actor, payload: { toolId } });
        if (toolId === 'notify_owner') {
          emit({ type: 'owner.notified', entityType: 'tool_execution', entityId: base.id, objectiveId: base.objectiveId, actor, payload: args });
        }
      });
      return { ok: true, message: 'OK', result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await withTx(this.ctx, async (tx, emit) => {
        if (approvalId) {
          await tx.update(toolExecutions).set({ status: 'failed', error, finishedAt: new Date() }).where(eq(toolExecutions.id, base.id));
        } else {
          await tx.insert(toolExecutions).values({ ...base, args, status: 'failed', error, finishedAt: new Date() });
        }
        emit({ type: 'tool.failed', entityType: 'tool_execution', entityId: base.id, objectiveId: base.objectiveId, actor, payload: { toolId, error } });
      });
      return { ok: false, message: `Tool gagal: ${error}` };
    }
  }

  /**
   * Permintaan persetujuan dari sistem sendiri (mis. aturan HRD menambah staf melewati batas).
   * Alurnya sama dengan tool berisiko tinggi: Owner menyetujui, lalu sistem mengeksekusi.
   */
  async systemRequest(toolId: string, args: Record<string, unknown>, reason: string, objectiveId: string | null = null) {
    const tool = toolById(toolId);
    if (!tool || tool.risk !== 'high') throw new UserError('Hanya tool berisiko tinggi yang bisa diminta lewat persetujuan');
    const approvalId = randomUUID();
    await withTx(this.ctx, async (tx, emit) => {
      await tx.insert(approvals).values({ id: approvalId, kind: 'tool', status: 'pending', objectiveId, toolId, args, reason });
      await tx.insert(toolExecutions).values({ id: randomUUID(), toolId, approvalId, objectiveId, args, status: 'pending_approval' });
      emit({ type: 'approval.requested', entityType: 'approval', entityId: approvalId, objectiveId, actor: 'orchestrator', payload: { toolId, title: tool.title } });
    });
    return approvalId;
  }

  /** Owner menyetujui: sistem (bukan agent) yang mengeksekusi dengan credential tersimpan. */
  /** Perusahaan otonom boleh menerbitkan sendiri bila Owner mengizinkan dan akses kanal sudah terpasang. */
  private async autoApprovable(toolId: string) {
    if (toolId !== 'instagram_publish') return false;
    const company = await getCompany(this.ctx.db);
    if (!company?.running || !company.autoPublish) return false;
    return !!(await publishableAccount(this.ctx));
  }

  async approve(approvalId: string, note?: string, actor: 'owner' | 'orchestrator' = 'owner') {
    const [a] = await this.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!a || a.status !== 'pending') throw new UserError('Persetujuan tidak ditemukan atau sudah diputuskan');
    const [exec] = await this.ctx.db.select().from(toolExecutions).where(eq(toolExecutions.approvalId, approvalId));
    await withTx(this.ctx, async (tx, emit) => {
      await tx.update(approvals).set({ status: 'approved', note: note ?? null, decidedAt: new Date() }).where(eq(approvals.id, approvalId));
      emit({ type: 'approval.approved', entityType: 'approval', entityId: approvalId, objectiveId: a.objectiveId, actor, payload: { toolId: a.toolId } });
    });
    return this.execute(
      { id: exec!.id, toolId: a.toolId!, agentId: a.agentId, taskId: a.taskId, sessionId: exec!.sessionId, objectiveId: a.objectiveId },
      a.toolId!,
      a.args as Record<string, unknown>,
      null,
      approvalId,
    );
  }

  async reject(approvalId: string, note?: string) {
    await withTx(this.ctx, async (tx, emit) => {
      const [a] = await tx.select().from(approvals).where(eq(approvals.id, approvalId));
      if (!a || a.status !== 'pending') throw new UserError('Persetujuan tidak ditemukan atau sudah diputuskan');
      await tx.update(approvals).set({ status: 'rejected', note: note ?? null, decidedAt: new Date() }).where(eq(approvals.id, approvalId));
      await tx.update(toolExecutions).set({ status: 'rejected', finishedAt: new Date() }).where(eq(toolExecutions.approvalId, approvalId));
      emit({ type: 'approval.rejected', entityType: 'approval', entityId: approvalId, objectiveId: a.objectiveId, actor: 'owner', payload: { toolId: a.toolId, note } });
    });
  }

  async removeCredential(toolId: string) {
    await withTx(this.ctx, async (tx, emit) => {
      const [existing] = await tx.select().from(toolCredentials).where(eq(toolCredentials.toolId, toolId));
      if (!existing) throw new UserError('Credential belum dipasang');
      await tx.delete(toolCredentials).where(eq(toolCredentials.toolId, toolId));
      emit({ type: 'tool.credential_removed', entityType: 'tool', entityId: toolId, actor: 'owner' });
    });
  }

  async setCredential(toolId: string, secret: string | undefined, config: Record<string, string>) {
    const tool = toolById(toolId);
    if (!tool?.credential) throw new UserError('Tool ini tidak memakai credential');
    const [existing] = await this.ctx.db.select().from(toolCredentials).where(eq(toolCredentials.toolId, toolId));
    const value = secret?.trim() || (existing ? this.ctx.secrets.decrypt(existing.secretEnc) : '');
    if (!value) throw new UserError('Credential wajib diisi');
    const row = { secretEnc: this.ctx.secrets.encrypt(value), secretLast4: value.slice(-4), config, updatedAt: new Date() };
    await withTx(this.ctx, async (tx, emit) => {
      await tx.insert(toolCredentials).values({ toolId, ...row }).onDuplicateKeyUpdate({ set: row });
      emit({ type: 'tool.credential_set', entityType: 'tool', entityId: toolId, actor: 'owner' });
    });
  }
}
