import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntime, Capability, NativeToolPolicy, RunRequest, RunResult } from './runtime';

export interface ClaudeCliOptions {
  bin: string;
  /** Config dir terpisah (login sendiri). Kosong = login Claude yang sudah ada. */
  configDir?: string;
}

// Tools bawaan per policy. --restricted sudah menghapus Bash & tool eksekusi kode
// dan membatasi tool file ke working directory.
const TOOLS: Record<NativeToolPolicy, string[]> = {
  read_only: ['Read', 'Glob', 'Grep'],
  workspace_write: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  research: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
};

/** Tool web: perlu izin eksplisit di mode headless. */
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

const RATE_LIMIT_RE = /rate.?limit|usage limit|limit reached|too many requests|\b429\b|quota/i;

/** Runtime utama: Claude Code mode headless (`claude -p`). */
export class ClaudeCliRuntime implements AgentRuntime {
  readonly id = 'claude-cli' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    'structured_output',
    'workspace_files',
    'web_research',
    'resume',
    'tools',
  ]);

  constructor(private opts: ClaudeCliOptions) {}

  buildArgs(req: RunRequest): string[] {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(req.outputSchema),
      '--append-system-prompt', req.systemPrompt,
      '--restricted',
      '--strict-mcp-config',
      '--permission-mode', 'acceptEdits',
      '--tools', TOOLS[req.nativeTools].join(','),
    ];
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    else args.push('--session-id', req.sessionId);
    if (req.model) args.push('--model', req.model);
    // Mode headless tidak bisa bertanya izin: tool yang tidak di-allow ditolak diam-diam (permission_denials).
    // acceptEdits hanya mencakup edit file, jadi riset web harus di-allow eksplisit. Hanya untuk policy research.
    const allowed = TOOLS[req.nativeTools].filter((t) => WEB_TOOLS.includes(t));
    if (req.mcpServers?.length) {
      // Izinkan semua tool dari server Gateway; izin per role ditegakkan Gateway.
      allowed.push(...req.mcpServers.map((m) => `mcp__${m.name}`));
      args.push('--mcp-config', mcpConfigPath(req));
    }
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    return args;
  }

  /** Env minimal: tanpa secret milik Virtual Office. HOME dibutuhkan untuk login CLI. */
  buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (this.opts.configDir) env.CLAUDE_CONFIG_DIR = this.opts.configDir;
    return env;
  }

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    await mkdir(path.dirname(req.logPath), { recursive: true });
    const log = createWriteStream(req.logPath, { flags: 'a' });
    log.write(`# ${new Date().toISOString()} session=${req.sessionId} resume=${req.resumeSessionId ?? '-'}\n`);

    if (req.mcpServers?.length) {
      // Di samping log sesi, di luar working directory agent. Berisi token sesi; dihapus setelah run.
      const mcpServers = Object.fromEntries(req.mcpServers.map((m) => [m.name, { type: 'http', url: m.url, headers: m.headers }]));
      await writeFile(mcpConfigPath(req), JSON.stringify({ mcpServers }), { mode: 0o600 });
    }
    const child = spawn(this.opts.bin, this.buildArgs(req), {
      cwd: req.workDir,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => ((stdout += c), log.write(c)));
    child.stderr.on('data', (c: Buffer) => ((stderr += c), log.write(c)));
    child.stdin.end(req.prompt);

    let timedOut = false;
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(() => ((timedOut = true), kill()), req.timeoutMs);
    signal.addEventListener('abort', kill, { once: true });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => ((stderr += String(err)), resolve(null)));
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(timer);
    signal.removeEventListener('abort', kill);
    await new Promise((r) => log.end(r));
    if (req.mcpServers?.length) await rm(mcpConfigPath(req), { force: true });

    const base = { externalSessionId: req.resumeSessionId ?? req.sessionId, durationMs: Date.now() - started };
    if (signal.aborted) return { ...base, status: 'aborted', output: null, usage: {} };
    if (timedOut) return { ...base, status: 'timeout', output: null, usage: {}, error: `Timeout setelah ${req.timeoutMs} ms` };
    return { ...base, ...parseClaudeOutput(stdout, stderr, exitCode) };
  }
}

const mcpConfigPath = (req: RunRequest) => `${req.logPath}.mcp.json`;

type Parsed = Omit<RunResult, 'externalSessionId' | 'durationMs'> & { externalSessionId?: string };

/** Memetakan output `claude -p --output-format json` ke RunResult. Diuji dengan fixture asli. */
export function parseClaudeOutput(stdout: string, stderr: string, exitCode: number | null): Parsed {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  let json: Record<string, any> | undefined;
  try {
    json = line ? JSON.parse(line) : undefined;
  } catch {
    json = undefined;
  }

  if (!json) {
    const error = (stderr || stdout || `exit ${exitCode}`).slice(0, 2000);
    return { status: RATE_LIMIT_RE.test(error) ? 'rate_limited' : 'error', output: null, usage: {}, error, retryAt: parseRetryAt(error) };
  }

  const u = json.usage ?? {};
  const usage = {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsdMicros: typeof json.total_cost_usd === 'number' ? Math.round(json.total_cost_usd * 1_000_000) : undefined,
  };
  const externalSessionId = typeof json.session_id === 'string' ? json.session_id : undefined;

  if (json.is_error || json.subtype !== 'success') {
    const error = String(json.result ?? json.api_error_status ?? json.subtype ?? 'error').slice(0, 2000);
    const limited = RATE_LIMIT_RE.test(error) || json.api_error_status === 429;
    return { status: limited ? 'rate_limited' : 'error', output: null, usage, error, externalSessionId, retryAt: parseRetryAt(error) };
  }

  let output: unknown = json.structured_output;
  if (output === undefined && typeof json.result === 'string') {
    try {
      output = JSON.parse(json.result);
    } catch {
      output = json.result;
    }
  }
  return { status: 'ok', output, usage, externalSessionId };
}

/** Pesan limit kadang menyebut waktu reset sebagai epoch detik ("...|1790990000"). */
function parseRetryAt(text: string): Date | undefined {
  const epoch = text.match(/\b(1[7-9]\d{8})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  return undefined;
}
