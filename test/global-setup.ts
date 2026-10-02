import { runMigrations } from '../src/db/migrate';

try {
  process.loadEnvFile();
} catch {
  // .env opsional.
}

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'mysql://vo:vo@localhost:3307/vo_test';

export default async function setup() {
  await runMigrations(TEST_DB);
}
