import { Pool } from 'pg';
import { getConfig } from '../config/env.js';

let pool = null;

export function getDbPool() {
  if (pool) {
    return pool;
  }

  const { databaseUrl } = getConfig();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to use persistent storage.');
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  return pool;
}

export async function closeDbPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
