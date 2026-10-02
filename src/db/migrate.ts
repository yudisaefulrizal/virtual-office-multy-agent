import { migrate } from 'drizzle-orm/mysql2/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './client';

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(url: string) {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config } = await import('../config');
  await runMigrations(config.databaseUrl);
  console.log('Migrasi selesai.');
}
