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
  // Mensimulasikan semua kemampuan claude-cli, termasuk riset web.
  readonly capabilities: ReadonlySet<Capability> = new Set(['structured_output', 'workspace_files', 'web_research', 'resume', 'tools']);
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

/** Bentuk output ditebak dari JSON schema yang diminta (planning, review, research, work). */
async function defaultHandler(req: RunRequest): Promise<Partial<RunResult>> {
  const props = Object.keys((req.outputSchema as { properties?: object }).properties ?? {});
  if (props.includes('tasks')) {
    return {
      output: {
        summary: 'Riset singkat lalu tulis konten.',
        tasks: [
          { key: 'riset', title: 'Riset tren', role: 'researcher', instructions: 'Kumpulkan tren dan sumbernya.', depends_on: [] },
          { key: 'konten', title: 'Tulis konten', role: 'content_writer', instructions: 'Tulis konten berdasarkan riset.', depends_on: ['riset'] },
        ],
        review_focus: 'Sesuai objective dan memakai hasil riset.',
      },
    };
  }
  if (props.includes('questions')) {
    return {
      output: {
        vision: 'Bangun kehadiran konten yang konsisten dan berkualitas.',
        questions: [
          { to: 'researcher', question: 'Format konten apa yang paling relevan untuk objective ini?' },
          { to: 'cfo', question: 'Berapa perkiraan biaya dan kuota per bulan?' },
        ],
      },
    };
  }
  if (props.includes('execution_brief')) {
    return {
      output: {
        strategy: 'Content-first organik, satu konten berkualitas per hari.',
        success_metrics: ['1 konten siap publish per hari'],
        budget_cap_usd: 5,
        team: [{ role: 'content_writer', runtime: 'claude-cli', reason: 'Menulis konten ke file' }],
        owner_requests: [],
        execution_brief: 'Riset singkat lalu tulis konten.',
      },
    };
  }
  if (props.includes('recommendation')) {
    return { output: { analysis: 'Analisis fake.', risks: ['Kuota terbatas'], recommendation: 'Mulai kecil.', alternatives: ['Pakai OpenRouter untuk konsultasi'] } };
  }
  if (props.includes('verdict')) {
    return { output: { verdict: 'accept', feedback: 'Hasil sesuai objective.', revisions: [] } };
  }
  const out = path.join(req.workDir, 'out');
  await mkdir(out, { recursive: true });
  const file = props.includes('findings') ? 'riset.md' : 'result.md';
  await writeFile(path.join(out, file), `# Hasil (fake runtime)\n\n${req.prompt.slice(0, 400)}\n`);
  const artifacts = [{ path: `out/${file}`, description: 'Hasil task' }];
  if (props.includes('findings')) {
    return {
      output: {
        summary: 'Riset dibuat oleh fake runtime.',
        findings: [{ point: 'Contoh temuan', source: 'tidak terverifikasi' }],
        artifacts,
        knowledge: [{ topic: 'Contoh knowledge riset', category: 'content', content: 'Carousel edukatif cocok untuk konten harian.', sources: ['https://example.com/a'] }],
      },
    };
  }
  return { output: { summary: 'Hasil dibuat oleh fake runtime.', artifacts } };
}
