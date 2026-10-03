import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { asc, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { UserError } from '../../domain';
import { z } from 'zod';
import { agentSessions, agents, artifacts, knowledge, roles } from '../../db/schema';
import { type OfficeContext, type StoredEvent, withTx } from '../../orchestrator/context';
import { KNOWLEDGE_CATEGORIES, isStale, listKnowledge } from '../../orchestrator/knowledge';
import { applyOrgChange, listOrg } from '../../orchestrator/org';
import { createObjective, promoteAllObjectives } from '../../orchestrator/office';
import { agentPerformance, changeAgentLifecycle } from '../../orchestrator/workforce';
import { deleteObjective } from '../../orchestrator/cleanup';
import { displayName, listResults, objectiveZip, readWorkspaceFile as readArtifactFile, safeName } from '../../orchestrator/results';
import { setObjectiveBudget } from '../../orchestrator/budget';
import { setSchedule } from '../../orchestrator/scheduler';
import { usageStats } from '../../orchestrator/stats';
import { registerMcp } from '../../gateway/mcp';
import { PROVIDER_IDS, listProviders, setProvider, updateAgent } from '../../orchestrator/providers';
import { decisionDetail, listApprovals, listDecisions, listObjectives, listTools, objectiveTrace, officeView } from '../../orchestrator/queries';
import { type SettingKey, getAllSettings, setSetting } from '../../orchestrator/settings';
import { approveDecision, rejectDecision, reviseDecision } from '../../orchestrator/strategy';
import type { Worker } from '../../orchestrator/worker';

const CreateObjectiveBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  mode: z.enum(['strategic', 'planned', 'direct']).optional(),
  schedule: z.lazy(() => ScheduleBody).optional(),
});
const ScheduleBody = z.object({
  kind: z.enum(['daily', 'interval']),
  timeOfDay: z.string().optional(),
  intervalHours: z.number().int().optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
});
const IdParams = z.object({ id: z.uuid() });

export function buildServer(ctx: OfficeContext, worker: Worker, webDist?: string) {
  const app = Fastify({ logger: { level: 'warn' } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'Input tidak valid', issues: err.issues });
    if (err instanceof UserError) return reply.status(400).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Terjadi kesalahan di server' });
  });

  app.get('/api/office', () => officeView(ctx, (id) => worker.runtimeState(id)));

  app.get('/api/objectives', () => listObjectives(ctx));

  app.post('/api/objectives', async (req, reply) => {
    const { schedule, ...body } = CreateObjectiveBody.parse(req.body);
    const created = await createObjective(ctx, body);
    if (schedule) await setSchedule(ctx, created.objectiveId, schedule);
    void worker.tick();
    return reply.status(201).send(created);
  });

  app.get('/api/objectives/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const trace = await objectiveTrace(ctx, id);
    return trace ?? reply.status(404).send({ error: 'Objective tidak ditemukan' });
  });

  // Provider runtime (OpenRouter). API key tidak pernah dikirim balik; hanya 4 karakter terakhir.
  app.get('/api/providers', () => listProviders(ctx));
  app.put('/api/providers/:id', async (req) => {
    const { id } = z.object({ id: z.enum(PROVIDER_IDS) }).parse(req.params);
    const body = z.object({ apiKey: z.string().trim().max(500).optional(), defaultModel: z.string().trim().min(3).max(128) }).parse(req.body);
    await setProvider(ctx, id, body);
    return listProviders(ctx);
  });

  app.get('/api/agents', async () => {
    const rows = await ctx.db
      .select({ agent: agents, roleName: roles.name, department: roles.department })
      .from(agents)
      .innerJoin(roles, eq(roles.id, agents.roleId))
      .orderBy(asc(roles.department), asc(agents.name));
    return rows.map((r) => ({ ...r.agent, roleName: r.roleName, department: r.department }));
  });
  app.patch('/api/agents/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z
      .object({
        runtime: z.enum(['claude-cli', 'openrouter']).optional(),
        model: z.string().trim().max(128).nullable().optional(),
        status: z.enum(['active', 'inactive']).optional(),
      })
      .parse(req.body);
    await updateAgent(ctx, id, body);
    return { ok: true };
  });

  app.get('/api/decisions', () => listDecisions(ctx));
  app.get('/api/decisions/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    return (await decisionDetail(ctx, id)) ?? reply.status(404).send({ error: 'Keputusan tidak ditemukan' });
  });
  const NoteBody = z.object({ note: z.string().trim().max(5000).optional() });
  app.post('/api/decisions/:id/approve', async (req) => {
    const { id } = IdParams.parse(req.params);
    await approveDecision(ctx, id, NoteBody.parse(req.body ?? {}).note);
    void worker.tick();
    return { ok: true };
  });
  app.post('/api/decisions/:id/revise', async (req) => {
    const { id } = IdParams.parse(req.params);
    await reviseDecision(ctx, id, NoteBody.parse(req.body ?? {}).note ?? '');
    void worker.tick();
    return { ok: true };
  });
  app.post('/api/decisions/:id/reject', async (req) => {
    const { id } = IdParams.parse(req.params);
    await rejectDecision(ctx, id, NoteBody.parse(req.body ?? {}).note);
    return { ok: true };
  });

  app.get('/api/knowledge', async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), category: z.enum(KNOWLEDGE_CATEGORIES).optional() }).parse(req.query);
    const rows = await listKnowledge(ctx.db, q);
    const now = new Date();
    return rows.map((r) => ({ ...r, stale: isStale(r, now) }));
  });
  app.delete('/api/knowledge/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await withTx(ctx, async (tx, emit) => {
      await tx.delete(knowledge).where(eq(knowledge.id, id));
      emit({ type: 'knowledge.deleted', entityType: 'knowledge', entityId: id, actor: 'owner' });
    });
    return { ok: true };
  });

  if (ctx.gateway) registerMcp(app, ctx.gateway);

  app.get('/api/approvals', async (req) => {
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query);
    return listApprovals(ctx, status);
  });
  app.post('/api/approvals/:id/approve', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!ctx.gateway) return reply.status(503).send({ error: 'Gateway tidak aktif' });
    return ctx.gateway.approve(id, NoteBody.parse(req.body ?? {}).note);
  });
  app.post('/api/approvals/:id/reject', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!ctx.gateway) return reply.status(503).send({ error: 'Gateway tidak aktif' });
    await ctx.gateway.reject(id, NoteBody.parse(req.body ?? {}).note);
    return { ok: true };
  });

  app.get('/api/tools', () => listTools(ctx));
  app.put('/api/tools/:id/credential', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const body = z.object({ secret: z.string().trim().max(2000).optional(), config: z.record(z.string(), z.string().max(200)).default({}) }).parse(req.body);
    if (!ctx.gateway) return reply.status(503).send({ error: 'Gateway tidak aktif' });
    await ctx.gateway.setCredential(id, body.secret, body.config);
    return listTools(ctx);
  });

  app.put('/api/objectives/:id/schedule', async (req) => {
    const { id } = IdParams.parse(req.params);
    await setSchedule(ctx, id, ScheduleBody.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/objectives/:id/schedule', async (req) => {
    const { id } = IdParams.parse(req.params);
    await setSchedule(ctx, id, null);
    return { ok: true };
  });

  app.patch('/api/objectives/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z.object({ budgetUsd: z.number().min(0).max(100_000).nullable() }).parse(req.body);
    await setObjectiveBudget(ctx, id, body.budgetUsd);
    void worker.tick();
    return { ok: true };
  });

  app.get('/api/stats', async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);
    return usageStats(ctx, days);
  });

  // Organisasi: Owner langsung membuat divisi/role atau merekrut staf (HRD mengusulkan lewat persetujuan).
  app.get('/api/org', () => listOrg(ctx));
  const OrgBody = z.object({
    type: z.enum(['hire', 'new_department', 'new_role']),
    reason: z.string().trim().max(500).default('Diminta Owner'),
    role_id: z.string().max(64).optional(),
    runtime: z.enum(['claude-cli', 'openrouter']).optional(),
    name: z.string().trim().max(128).optional(),
    department_id: z.string().max(64).optional(),
    color: z.string().max(9).optional(),
    instructions: z.string().max(3000).optional(),
    native_tools: z.enum(['read_only', 'workspace_write', 'research']).optional(),
    task_kind: z.enum(['work', 'research']).optional(),
    description: z.string().max(300).optional(),
  });
  app.post('/api/org', async (req) => {
    await applyOrgChange(ctx, OrgBody.parse(req.body), 'owner', 'owner');
    void worker.tick();
    return listOrg(ctx);
  });

  app.get('/api/settings', () => getAllSettings(ctx.db));

  // Siklus hidup agent oleh Owner: rumahkan, aktifkan kembali, atau pensiunkan (arsip).
  app.post('/api/agents/:id/lifecycle', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { action } = z.object({ action: z.enum(['suspend', 'reactivate', 'retire']) }).parse(req.body);
    const out = await changeAgentLifecycle(ctx, id, action, 'owner', 'Keputusan Owner', () => promoteAllObjectives(ctx));
    void worker.tick();
    return out;
  });

  app.get('/api/performance', () => agentPerformance(ctx));

  // Mulai hitung kuota dari nol (mis. jendela Claude sebenarnya sudah pulih).
  app.post('/api/quota/reset', async () => {
    await withTx(ctx, async (tx, emit) => {
      await setSetting(tx, 'quota_counted_since', new Date().toISOString());
      emit({ type: 'quota.reset', entityType: 'setting', entityId: 'quota_counted_since', actor: 'owner' });
    });
    void worker.tick();
    return { ok: true };
  });

  app.delete('/api/objectives/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await deleteObjective(ctx, id);
    return reply.status(204).send();
  });
  app.put('/api/settings', async (req) => {
    const body = z
      .object({
        decision_approval: z.enum(['always', 'auto']).optional(),
        usd_to_idr: z.number().positive().max(1_000_000).optional(),
        max_staff_per_role: z.number().int().min(1).max(20).optional(),
        auto_hire: z.enum(['auto', 'ask']).optional(),
        hire_wait_seconds: z.number().int().min(10).max(3600).optional(),
        suspend_idle_minutes: z.number().int().min(0).max(1440).optional(),
        claude_max_runs_per_window: z.number().int().min(-1).max(1000).optional(),
      })
      .parse(req.body);
    await withTx(ctx, async (tx, emit) => {
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        await setSetting(tx, k as SettingKey, v as never);
        emit({ type: 'setting.updated', entityType: 'setting', entityId: k, actor: 'owner', payload: { value: v } });
      }
    });
    return getAllSettings(ctx.db);
  });

  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const ok = await worker.cancel(id);
    return ok ? { ok } : reply.status(409).send({ error: 'Task tidak bisa dibatalkan' });
  });

  // File dibaca hanya jika path-nya tercatat di DB dan berada di dalam folder workspaces.
  const readWorkspaceFile = (rel: string) => readArtifactFile(ctx, rel);

  app.get('/api/artifacts/:id/content', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [a] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, id));
    if (!a) return reply.status(404).send({ error: 'Artifact tidak ditemukan' });
    const buf = await readWorkspaceFile(a.path).catch(() => null);
    if (!buf) return reply.status(410).send({ error: 'File artifact sudah tidak ada' });
    const textual = !a.mimeType || /^text\/|json|svg/.test(a.mimeType);
    return reply.type(textual ? 'text/plain; charset=utf-8' : a.mimeType!).send(buf);
  });

  app.get('/api/artifacts/:id/download', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [a] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, id));
    if (!a) return reply.status(404).send({ error: 'Artifact tidak ditemukan' });
    const buf = await readWorkspaceFile(a.path).catch(() => null);
    if (!buf) return reply.status(410).send({ error: 'File artifact sudah tidak ada' });
    const name = displayName(a.path).split('/').pop()!;
    return reply
      .header('content-disposition', `attachment; filename="${safeName(name, 'file').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type('application/octet-stream')
      .send(buf);
  });

  // Hasil kerja: daftar per objective, dan unduhan ZIP satu objective.
  app.get('/api/results', () => listResults(ctx));

  app.get('/api/objectives/:id/download', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { semua } = z.object({ semua: z.enum(['1']).optional() }).parse(req.query);
    const out = await objectiveZip(ctx, id, semua === '1');
    if (!out) return reply.status(404).send({ error: 'Belum ada hasil akhir untuk objective ini' });
    return reply
      .header('content-disposition', `attachment; filename="${safeName(out.title)}.zip"`)
      .type('application/zip')
      .send(out.zip);
  });

  app.get('/api/sessions/:id/log', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [s] = await ctx.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    if (!s?.logPath) return reply.status(404).send({ error: 'Log tidak ditemukan' });
    const buf = await readWorkspaceFile(s.logPath).catch(() => Buffer.from(''));
    return reply.type('text/plain; charset=utf-8').send(buf);
  });

  // Server-Sent Events: UI memuat ulang data saat ada event baru.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const onEvent = (ev: StoredEvent) => reply.raw.write(`data: ${JSON.stringify({ id: ev.id, type: ev.type, objectiveId: ev.objectiveId })}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    ctx.bus.on('event', onEvent);
    req.raw.on('close', () => {
      clearInterval(ping);
      ctx.bus.off('event', onEvent);
    });
  });

  if (webDist && existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Tidak ditemukan' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
