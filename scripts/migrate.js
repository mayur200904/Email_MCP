import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../src/config/env.js';
import { getDbPool, closeDbPool } from '../src/db/client.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, '../src/db/migrations');

async function run() {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const files = (await fs.readdir(migrationsDir)).sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      console.log(`Applied migration: ${file}`);
    }
  } finally {
    client.release();
    await closeDbPool();
  }
}

run().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
