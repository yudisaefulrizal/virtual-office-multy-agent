import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Gateway } from './gateway';
import { toolsForRole } from './tools';

/**
 * Endpoint MCP (stateless) untuk sesi agent. Agent hanya melihat tool yang diizinkan
 * untuk role-nya; setiap panggilan tetap diperiksa ulang oleh Gateway.
 */
export function registerMcp(app: FastifyInstance, gateway: Gateway) {
  const handler = async (req: any, reply: any) => {
    const auth = String(req.headers.authorization ?? '');
    const caller = gateway.resolve(auth.startsWith('Bearer ') ? auth.slice(7) : undefined);
    if (!caller) return reply.status(401).send({ error: 'Token sesi tidak valid' });

    const server = new McpServer({ name: 'virtual-office', version: '0.1.0' });
    for (const tool of toolsForRole(caller.roleId)) {
      server.registerTool(
        tool.id,
        { title: tool.title, description: `${tool.description}${tool.risk === 'high' ? ' (butuh persetujuan Owner)' : ''}`, inputSchema: tool.input },
        async (args: Record<string, unknown>) => {
          const r = await gateway.call(caller, tool.id, args);
          const text = r.result === undefined ? r.message : JSON.stringify(r.result, null, 2);
          return { content: [{ type: 'text' as const, text }], isError: !r.ok };
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', handler);
  app.get('/mcp', (_req, reply) => reply.status(405).send({ error: 'Gunakan POST' }));
  app.delete('/mcp', (_req, reply) => reply.status(405).send({ error: 'Stateless' }));
}
