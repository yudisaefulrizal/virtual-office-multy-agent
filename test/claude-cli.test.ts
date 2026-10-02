import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRuntime, parseClaudeOutput } from '../src/runtimes/claude-cli';

const fixture = readFileSync(new URL('./fixtures/claude-cli-success.json', import.meta.url), 'utf8');

describe('parseClaudeOutput', () => {
  it('membaca structured_output, session id, token, dan biaya dari output asli', () => {
    const r = parseClaudeOutput(fixture, '', 0);
    expect(r.status).toBe('ok');
    expect(r.externalSessionId).toBe('276d3eb0-1ad9-4e90-b191-6a5204cedc14');
    expect(r.output).toMatchObject({ files: ['out/hello.md'] });
    expect(r.usage.outputTokens).toBe(307);
    expect(r.usage.inputTokens).toBe(4 + 3817 + 3514);
    expect(r.usage.costUsdMicros).toBe(38388);
  });

  it('mengenali rate limit dari hasil error', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached|1790990000' });
    const r = parseClaudeOutput(line, '', 1);
    expect(r.status).toBe('rate_limited');
    expect(r.retryAt?.getTime()).toBe(1790990000 * 1000);
  });

  it('stdout bukan JSON dianggap error dengan pesan stderr', () => {
    const r = parseClaudeOutput('', 'command not found', 127);
    expect(r.status).toBe('error');
    expect(r.error).toContain('command not found');
  });
});

describe('ClaudeCliRuntime', () => {
  const rt = new ClaudeCliRuntime({ bin: 'claude' });
  const req = {
    workDir: '/tmp/x', systemPrompt: 'sys', prompt: 'p', sessionId: 'sid', outputSchema: { type: 'object' },
    nativeTools: 'workspace_write' as const, model: 'sonnet', timeoutMs: 1000, logPath: '/tmp/x.log',
  };

  it('selalu memakai mode restricted dan tanpa MCP pribadi', () => {
    const args = rt.buildArgs(req);
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Glob,Grep');
    expect(args[args.indexOf('--session-id') + 1]).toBe('sid');
  });

  it('resume memakai --resume, bukan --session-id', () => {
    const args = rt.buildArgs({ ...req, resumeSessionId: 'prev' });
    expect(args[args.indexOf('--resume') + 1]).toBe('prev');
    expect(args).not.toContain('--session-id');
  });

  it('env proses agent tidak membawa secret', () => {
    process.env.SUPER_SECRET = 'x';
    process.env.DATABASE_URL_FAKE = 'postgres://secret';
    const env = rt.buildEnv();
    expect(env.SUPER_SECRET).toBeUndefined();
    expect(env.DATABASE_URL_FAKE).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});
