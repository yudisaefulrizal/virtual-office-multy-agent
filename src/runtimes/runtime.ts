/**
 * Kontrak antara orchestrator dan runtime agent (docs/DESIGN.md §6).
 * Runtime tidak tahu soal Task, Agent, atau Role: ia hanya menjalankan
 * prompt di sebuah folder dengan batasan tertentu.
 */

export type RuntimeId = 'claude-cli' | 'openrouter' | 'fake';

export type Capability = 'structured_output' | 'workspace_files' | 'web_research' | 'resume';

/** Akses tools bawaan runtime. Tool eksternal nanti lewat Tool Gateway. */
export type NativeToolPolicy = 'read_only' | 'workspace_write' | 'research';

export interface RunRequest {
  workDir: string;
  systemPrompt: string;
  prompt: string;
  /** ID sesi yang dibuat orchestrator sebelum run, agar tercatat walau proses crash. */
  sessionId: string;
  /** Lanjutkan percakapan sebelumnya (repair output / revisi). */
  resumeSessionId?: string;
  outputSchema: Record<string, unknown>;
  nativeTools: NativeToolPolicy;
  model?: string;
  timeoutMs: number;
  logPath: string;
}

export type RunStatus = 'ok' | 'error' | 'timeout' | 'aborted' | 'rate_limited';

export interface RunResult {
  status: RunStatus;
  externalSessionId: string;
  /** Output terstruktur mentah. Divalidasi oleh pemanggil, bukan runtime. */
  output: unknown;
  error?: string;
  /** Untuk rate_limited: kapan boleh dicoba lagi, jika runtime mengetahuinya. */
  retryAt?: Date;
  usage: { inputTokens?: number; outputTokens?: number; costUsdMicros?: number };
  durationMs: number;
}

export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: ReadonlySet<Capability>;
  run(req: RunRequest, signal: AbortSignal): Promise<RunResult>;
}
