import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntime, Capability, RunRequest, RunResult } from './runtime';

export type FakeHandler = (req: RunRequest, call: number) => Promise<Partial<RunResult>> | Partial<RunResult>;

/**
 * Runtime deterministik untuk test dan development tanpa kuota.
 * Default: menulis out/result.md dan mengembalikan output task `work` yang valid.
 */
export class FakeRuntime implements AgentRuntime {
  readonly id = 'fake' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(['structured_output', 'workspace_files', 'resume']);
  calls: RunRequest[] = [];

  constructor(
    private handler: FakeHandler = defaultHandler,
    private delayMs = 0,
  ) {}

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    this.calls.push(req);
    const started = Date.now();
    if (this.delayMs > 0) {
      const aborted = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.delayMs);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve(true)), { once: true });
      });
      if (aborted) return { status: 'aborted', externalSessionId: req.sessionId, output: null, usage: {}, durationMs: Date.now() - started };
    }
    const partial = await this.handler(req, this.calls.length);
    return {
      status: 'ok',
      externalSessionId: req.resumeSessionId ?? req.sessionId,
      output: null,
      usage: { inputTokens: 100, outputTokens: 50, costUsdMicros: 0 },
      durationMs: Date.now() - started,
      ...partial,
    };
  }
}

async function defaultHandler(req: RunRequest): Promise<Partial<RunResult>> {
  const out = path.join(req.workDir, 'out');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'result.md'), `# Hasil (fake runtime)\n\n${req.prompt.slice(0, 400)}\n`);
  return {
    output: {
      summary: 'Hasil dibuat oleh fake runtime.',
      artifacts: [{ path: 'out/result.md', description: 'Hasil task' }],
    },
  };
}
