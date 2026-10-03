import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, approvals, tasks, toolExecutions } from '../src/db/schema';
import { Gateway } from '../src/gateway/gateway';
import type { Caller } from '../src/gateway/tools';
import { buildServer } from '../src/interface/http/server';
import { setObjectiveBudget } from '../src/orchestrator/budget';
import { createObjective } from '../src/orchestrator/office';
import { objectiveTrace, officeView } from '../src/orchestrator/queries';
import { ClaudeCliRuntime } from '../src/runtimes/claude-cli';
import { FakeRuntime } from '../src/runtimes/fake';
import { setupOffice } from './helpers';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanup?.();
  cleanup = undefined;
});

async function office(handler?: Parameters<typeof setupOffice>[0]) {
  const o = await setupOffice(handler);
  cleanup = async () => (await o.worker.stop(), await o.close());
  return o;
}

async function callerFor(db: Awaited<ReturnType<typeof office>>['db'], roleId: string, objectiveId = '00000000-0000-0000-0000-000000000000'): Promise<Caller> {
  const [a] = await db.select().from(agents).where(eq(agents.roleId, roleId));
  return { agentId: a!.id, agentName: a!.name, roleId, taskId: '00000000-0000-0000-0000-000000000001', sessionId: '00000000-0000-0000-0000-000000000002', objectiveId };
}

describe('Tool Gateway', () => {
  it('MCP: agent hanya melihat tool role-nya, token wajib, panggilan teraudit', async () => {
    const o = await office();
    const app = buildServer(o.ctx, o.worker);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    o.ctx.gateway = new Gateway(o.ctx, `http://127.0.0.1:${port}`);
    // Server dibangun sebelum gateway dipasang: daftarkan ulang lewat server baru.
    await app.close();
    const app2 = buildServer(o.ctx, o.worker);
    await app2.listen({ port, host: '127.0.0.1' });
    const prev = cleanup;
    cleanup = async () => (await app2.close(), await prev?.());

    const connect = async (token: string) => {
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
      return client;
    };

    const writer = await connect(o.ctx.gateway.issueToken(await callerFor(o.db, 'content_writer')));
    expect((await writer.listTools()).tools.map((t) => t.name).sort()).toEqual(['instagram_publish', 'knowledge_search', 'notify_owner']);
    const researcher = await connect(o.ctx.gateway.issueToken(await callerFor(o.db, 'researcher')));
    expect((await researcher.listTools()).tools.map((t) => t.name)).not.toContain('instagram_publish');

    const r = await writer.callTool({ name: 'knowledge_search', arguments: { query: 'kopi' } });
    expect(r.isError).toBeFalsy();
    const execs = await o.db.select().from(toolExecutions);
    expect(execs.map((e) => [e.toolId, e.status])).toEqual([['knowledge_search', 'executed']]);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer palsu', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    await writer.close();
    await researcher.close();
  });

  it('tool di luar izin role ditolak dan dicatat', async () => {
    const o = await office();
    const gw = new Gateway(o.ctx, 'http://x');
    const r = await gw.call(await callerFor(o.db, 'researcher'), 'instagram_publish', { image_url: 'https://a.com/x.jpg', caption: 'hi' });
    expect(r.ok).toBe(false);
    const [e] = await o.db.select().from(toolExecutions);
    expect(e?.status).toBe('denied');
    expect(o.emitted.some((x) => x.type === 'tool.denied')).toBe(true);
  });

  it('tool berisiko menunggu Owner; dieksekusi sistem dengan credential setelah disetujui', async () => {
    const o = await office();
    const gw = new Gateway(o.ctx, 'http://x');
    o.ctx.gateway = gw;
    const caller = await callerFor(o.db, 'content_writer');
    const r = await gw.call(caller, 'instagram_publish', { image_url: 'https://cdn.example.com/a.jpg', caption: 'Kopi pagi' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('persetujuan Owner');
    const [a] = await o.db.select().from(approvals);
    expect(a?.status).toBe('pending');
    const view = await officeView(o.ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.inbox.map((i) => i.kind)).toContain('approval_pending');

    // Tanpa credential → gagal dengan pesan jelas.
    const fail = await gw.approve(a!.id);
    expect(fail.ok).toBe(false);
    expect(fail.message).toContain('belum dipasang');

    // Permintaan kedua, kali ini credential ada dan Graph API ditiru.
    await gw.setCredential('instagram_publish', 'EAAtoken-1234', { ig_user_id: '1789', api_version: 'v21.0' });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(`${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ id: url.endsWith('/media') ? 'creation-1' : 'media-9' }), { status: 200 });
    });
    await gw.call(caller, 'instagram_publish', { image_url: 'https://cdn.example.com/b.jpg', caption: 'Kopi sore' });
    const [pending] = await o.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    const ok = await gw.approve(pending!.id);
    expect(ok).toMatchObject({ ok: true, result: { mediaId: 'media-9' } });
    expect(calls[0]).toContain('graph.facebook.com/v21.0/1789/media');
    expect(calls[0]).toContain('access_token=EAAtoken-1234');
    expect(calls[1]).toContain('creation_id=creation-1');
    const [exec] = await o.db.select().from(toolExecutions).where(eq(toolExecutions.approvalId, pending!.id));
    expect(exec?.status).toBe('executed');
  });

  it('Claude CLI menerima konfigurasi MCP Gateway', () => {
    const args = new ClaudeCliRuntime({ bin: 'claude' }).buildArgs({
      workDir: '/w', systemPrompt: 's', prompt: 'p', sessionId: 'sid', outputSchema: {}, nativeTools: 'workspace_write', timeoutMs: 1, logPath: '/l/s.log',
      mcpServers: [{ name: 'vo', url: 'http://127.0.0.1:8070/mcp', headers: { Authorization: 'Bearer t' } }],
    });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/l/s.log.mcp.json');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__vo');
    expect(args).toContain('--strict-mcp-config');
  });
});

describe('Budget objective', () => {
  it('biaya API nyata melewati budget → task ditunda; budget dinaikkan → jalan lagi', async () => {
    const o = await office(async (req) => ({ ...(await new FakeRuntime().run(req, new AbortController().signal)), usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 2_000_000 } }));
    const { objectiveId } = await createObjective(o.ctx, { title: 'Budget kecil', mode: 'planned' });
    await setObjectiveBudget(o.ctx, objectiveId, 1);
    await o.worker.drain();

    const blocked = await o.db.select().from(tasks).where(and(eq(tasks.objectiveId, objectiveId), eq(tasks.error, 'Budget objective habis')));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.status).toBe('queued');
    const view = await officeView(o.ctx, () => ({ inflight: 0, cooldownUntil: null }));
    expect(view.inbox.map((i) => i.kind)).toContain('budget_exceeded');

    await setObjectiveBudget(o.ctx, objectiveId, 100);
    await o.worker.drain();
    const trace = await objectiveTrace(o.ctx, objectiveId);
    expect(trace?.objective.status).toBe('completed');
    expect(trace?.budget.spentUsdMicros).toBe(8_000_000);
  });
});
