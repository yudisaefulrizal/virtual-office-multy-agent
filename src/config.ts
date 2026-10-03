import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // .env opsional; environment variable tetap dipakai.
}

const str = (key: string, fallback: string) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
const int = (key: string, fallback: number) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const config = {
  databaseUrl: str('DATABASE_URL', 'mysql://vo:vo@localhost:3307/vo'),
  port: int('PORT', 8070),
  workspacesDir: path.resolve(str('WORKSPACES_DIR', './workspaces')),
  defaultModel: str('VO_DEFAULT_MODEL', 'sonnet'),
  forceRuntime: process.env.VO_FORCE_RUNTIME || undefined,
  /** 64 karakter hex. Kosong = dibuat otomatis di file .vo-secret. */
  secretKey: process.env.VO_SECRET_KEY || undefined,
  secretFile: path.resolve(str('VO_SECRET_FILE', './.vo-secret')),
  claudeCli: {
    bin: str('CLAUDE_CLI_BIN', 'claude'),
    configDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    // Paralel secukupnya: turun sendiri saat kena rate limit (lihat Worker.adjustCap).
    concurrency: int('CLAUDE_CLI_CONCURRENCY', 3),
    maxRunsPerWindow: int('CLAUDE_CLI_MAX_RUNS_PER_WINDOW', 30),
    windowHours: int('CLAUDE_CLI_WINDOW_HOURS', 5),
    billing: str('CLAUDE_CLI_BILLING', 'subscription') === 'api' ? ('actual' as const) : ('estimate' as const),
  },
};

export type Config = typeof config;
