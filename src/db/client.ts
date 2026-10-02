import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema';

export function createDb(url: string) {
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: 10,
    // Simpan dan baca waktu sebagai UTC; kolom DATETIME MySQL tidak menyimpan zona waktu.
    timezone: 'Z',
    dateStrings: false,
  });
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, close: () => pool.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
/** Transaksi atau koneksi biasa; repository menerima keduanya. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

/** Baris hasil `db.execute(sql…)` pada driver mysql2. */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result[0] : []) as T[];
}
