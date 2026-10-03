import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntime, Capability, RunRequest, RunResult } from './runtime';

export interface OpenRouterOptions {
  apiKey: string;
  defaultModel: string;
  /** Folder transcript percakapan; dipakai untuk mensimulasikan resume. */
  transcriptDir: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Runtime berbasis API untuk role yang cukup bernalar tanpa akses file
 * (konsultasi eksekutif, perencanaan). Tidak punya workspace_files atau
 * web_research, jadi orchestrator tidak akan memberinya task yang butuh itu.
 */
export class OpenRouterRuntime implements AgentRuntime {
  readonly id = 'openrouter' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(['structured_output', 'resume']);
  private baseUrl: string;
  private doFetch: typeof fetch;

  constructor(private opts: OpenRouterOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.doFetch = opts.fetch ?? fetch;
  }

  private transcriptPath(id: string) {
    return path.join(this.opts.transcriptDir, `${id}.json`);
  }

  async run(req: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    const base = { externalSessionId: req.sessionId, usage: {}, output: null };
    await mkdir(this.opts.transcriptDir, { recursive: true });
    await mkdir(path.dirname(req.logPath), { recursive: true });

    let messages: Message[];
    if (req.resumeSessionId) {
      try {
        messages = JSON.parse(await readFile(this.transcriptPath(req.resumeSessionId), 'utf8')) as Message[];
      } catch {
        return { ...base, status: 'error', error: `Transcript ${req.resumeSessionId} tidak ditemukan`, durationMs: Date.now() - started };
      }
    } else {
      messages = [{ role: 'system', content: req.systemPrompt }];
    }
    messages.push({ role: 'user', content: req.prompt });

    const model = req.model ?? this.opts.defaultModel;
    const body = {
      model,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'output', strict: false, schema: req.outputSchema } },
      usage: { include: true },
    };
    await appendFile(req.logPath, `# ${new Date().toISOString()} model=${model} session=${req.sessionId}\n> ${req.prompt.slice(0, 2000)}\n`);

    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json', 'x-title': 'Virtual Office' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(req.timeoutMs)]),
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      if (signal.aborted) return { ...base, status: 'aborted', durationMs };
      if ((err as Error).name === 'TimeoutError') return { ...base, status: 'timeout', error: `Timeout setelah ${req.timeoutMs} ms`, durationMs };
      return { ...base, status: 'error', error: String(err), durationMs };
    }

    const text = await res.text();
    await appendFile(req.logPath, `< HTTP ${res.status}\n${text.slice(0, 20000)}\n`);
    const durationMs = Date.now() - started;

    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return { ...base, status: 'rate_limited', error: 'OpenRouter rate limit', retryAt: after > 0 ? new Date(Date.now() + after * 1000) : undefined, durationMs };
    }
    if (!res.ok) return { ...base, status: 'error', error: `OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`, durationMs };

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ...base, status: 'error', error: 'Respons OpenRouter bukan JSON', durationMs };
    }
    const content: string = json.choices?.[0]?.message?.content ?? '';
    const usage = {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      costUsdMicros: typeof json.usage?.cost === 'number' ? Math.round(json.usage.cost * 1_000_000) : undefined,
    };
    messages.push({ role: 'assistant', content });
    await writeFile(this.transcriptPath(req.sessionId), JSON.stringify(messages));

    let output: unknown = content;
    try {
      output = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      // Biarkan sebagai teks; validasi orchestrator akan memicu repair.
    }
    return { status: 'ok', externalSessionId: req.sessionId, output, usage, durationMs };
  }
}
