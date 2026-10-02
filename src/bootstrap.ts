import { EventEmitter } from 'node:events';
import type { Config } from './config';
import type { Db } from './db/client';
import type { OfficeContext, RuntimeLimits } from './orchestrator/context';
import { ClaudeCliRuntime } from './runtimes/claude-cli';
import { FakeRuntime } from './runtimes/fake';
import type { AgentRuntime, RuntimeId } from './runtimes/runtime';

/** Rakit context aplikasi dari config. OpenRouter menyusul (DESIGN.md langkah 10). */
export function createContext(config: Config, db: Db): OfficeContext {
  const runtimes = new Map<RuntimeId, AgentRuntime>([
    ['claude-cli', new ClaudeCliRuntime({ bin: config.claudeCli.bin, configDir: config.claudeCli.configDir })],
    ['fake', new FakeRuntime(undefined, 4000)],
  ]);
  const limits = new Map<RuntimeId, RuntimeLimits>([
    [
      'claude-cli',
      {
        concurrency: config.claudeCli.concurrency,
        maxRunsPerWindow: config.claudeCli.maxRunsPerWindow,
        windowHours: config.claudeCli.windowHours,
        costKind: config.claudeCli.billing,
      },
    ],
    ['fake', { concurrency: 2, costKind: 'actual' }],
  ]);
  const forceRuntime = config.forceRuntime as RuntimeId | undefined;
  if (forceRuntime && !runtimes.has(forceRuntime)) throw new Error(`VO_FORCE_RUNTIME tidak dikenal: ${forceRuntime}`);

  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  return { db, bus, workspacesDir: config.workspacesDir, defaultModel: config.defaultModel, runtimes, limits, forceRuntime };
}
