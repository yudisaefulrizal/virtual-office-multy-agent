import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './bootstrap';
import { config } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { buildServer } from './interface/http/server';
import { seedOrganization } from './orchestrator/office';
import { loadProviders } from './orchestrator/providers';
import { Worker } from './orchestrator/worker';

await mkdir(config.workspacesDir, { recursive: true });
await runMigrations(config.databaseUrl);

const { db, close } = createDb(config.databaseUrl);
const ctx = createContext(config, db);
await seedOrganization(ctx);
await loadProviders(ctx);

const worker = new Worker(ctx);
await worker.start();

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
const app = buildServer(ctx, worker, webDist);
await app.listen({ port: config.port, host: '127.0.0.1' });

console.log(`Virtual Office berjalan di http://localhost:${config.port}`);
if (ctx.forceRuntime) console.log(`Semua agent memakai runtime: ${ctx.forceRuntime}`);

const shutdown = async () => {
  console.log('Menghentikan Virtual Office…');
  await app.close();
  await worker.stop();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
