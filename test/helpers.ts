import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import type { OfficeContext, StoredEvent } from '../src/orchestrator/context';
import { seedOrganization } from '../src/orchestrator/office';
import { Worker } from '../src/orchestrator/worker';
import { FakeRuntime, type FakeHandler } from '../src/runtimes/fake';
import { SecretBox } from '../src/secrets';
import { TEST_DB } from './global-setup';

export async function setupOffice(handler?: FakeHandler, opts: { maxRunsPerWindow?: number } = {}) {
  const { db, close } = createDb(TEST_DB);
  // FOREIGN_KEY_CHECKS bersifat per sesi: jalankan di satu koneksi lewat transaksi.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set foreign_key_checks = 0`);
    for (const t of ['events', 'artifacts', 'agent_sessions', 'task_dependencies', 'tasks', 'projects', 'decisions', 'objectives', 'agents', 'roles']) {
      await tx.execute(sql.raw(`delete from ${t}`));
    }
    await tx.execute(sql`set foreign_key_checks = 1`);
  });
  const runtime = new FakeRuntime(handler);
  const bus = new EventEmitter();
  const emitted: StoredEvent[] = [];
  bus.on('event', (e: StoredEvent) => emitted.push(e));
  const ctx: OfficeContext = {
    db,
    bus,
    workspacesDir: await mkdtemp(path.join(os.tmpdir(), 'vo-test-')),
    defaultModel: 'sonnet',
    runtimes: new Map([['fake', runtime]]),
    limits: new Map([['fake', { concurrency: 1, costKind: 'actual', maxRunsPerWindow: opts.maxRunsPerWindow, windowHours: opts.maxRunsPerWindow ? 5 : undefined }]]),
    forceRuntime: 'fake',
    secrets: new SecretBox(randomBytes(32).toString('hex')),
  };
  await seedOrganization(ctx);
  const worker = new Worker(ctx, { retryBackoffMs: 0 });
  return { ctx, db, runtime, worker, emitted, close };
}
