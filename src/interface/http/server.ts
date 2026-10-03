import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { UserError } from '../../domain';
import { z } from 'zod';
import { agentSessions, agents, artifacts, roles } from '../../db/schema';
import { type OfficeContext, type StoredEvent, withTx } from '../../orchestrator/context';
import { createObjective } from '../../orchestrator/office';
import { PROVIDER_IDS, listProviders, setProvider, updateAgent } from '../../orchestrator/providers';
import { decisionDetail, listDecisions, listObjectives, objectiveTrace, officeView } from '../../orchestrator/queries';
import { type SettingKey, getAllSettings, setSetting } from '../../orchestrator/settings';
import { approveDecision, rejectDecision, reviseDecision } from '../../orchestrator/strategy';
import type { Worker } from '../../orchestrator/worker';

const CreateObjectiveBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  mode: z.enum(['strategic', 'planned', 'direct']).optional(),
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
    const body = CreateObjectiveBody.parse(req.body);
    const created = await createObjective(ctx, body);
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
    const rows = await ctx.db.select({ agent: agents, roleName: roles.name, department: roles.department }).from(agents).innerJoin(roles, eq(roles.id, agents.roleId));
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

  app.get('/api/settings', () => getAllSettings(ctx.db));
  app.put('/api/settings', async (req) => {
    const body = z
      .object({ decision_approval: z.enum(['always', 'auto']).optional(), usd_to_idr: z.number().positive().max(1_000_000).optional() })
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
  const readWorkspaceFile = async (rel: string) => {
    const full = path.resolve(ctx.workspacesDir, rel);
    if (!full.startsWith(ctx.workspacesDir + path.sep)) throw new Error('Path di luar workspace');
    return readFile(full);
  };

  app.get('/api/artifacts/:id/content', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [a] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, id));
    if (!a) return reply.status(404).send({ error: 'Artifact tidak ditemukan' });
    const buf = await readWorkspaceFile(a.path).catch(() => null);
    if (!buf) return reply.status(410).send({ error: 'File artifact sudah tidak ada' });
    const textual = !a.mimeType || /^text\/|json|svg/.test(a.mimeType);
    return reply.type(textual ? 'text/plain; charset=utf-8' : a.mimeType!).send(buf);
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
