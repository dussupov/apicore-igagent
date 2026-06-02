import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

export const databaseState = {
  configured: false,
  connected: false,
  error: null,
  message: ''
};

function readDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) {
    databaseState.message = 'DATABASE_URL is missing. On Render deploy with render.yaml Blueprint or create PostgreSQL and attach DATABASE_URL.';
    return null;
  }
  if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('::1')) {
    databaseState.message = 'DATABASE_URL points to localhost. On Render use the PostgreSQL Internal Database URL.';
    return null;
  }
  databaseState.configured = true;
  return url;
}

const connectionString = readDatabaseUrl();
const needsSsl = connectionString && (
  process.env.PGSSLMODE === 'require' ||
  process.env.NODE_ENV === 'production' ||
  /render\.com|oregon-postgres|singapore-postgres|frankfurt-postgres|ohio-postgres/.test(connectionString)
);

export const pool = connectionString ? new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

export function hasDatabase() {
  return Boolean(pool && databaseState.connected);
}

export async function query(text, params = []) {
  if (!pool) {
    const err = new Error(databaseState.message || 'Database is not configured.');
    err.code = 'DATABASE_NOT_CONFIGURED';
    throw err;
  }
  return pool.query(text, params);
}

export async function initDb() {
  if (!pool) {
    console.warn(`\n[DATABASE_DISABLED] ${databaseState.message}`);
    return false;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    await pool.query('SELECT 1');
    await pool.query(sql);
    databaseState.connected = true;
    databaseState.error = null;
    databaseState.message = 'connected';
    return true;
  } catch (err) {
    databaseState.connected = false;
    databaseState.error = err.message || String(err);
    databaseState.message = 'Could not connect to PostgreSQL. Check DATABASE_URL and database availability.';
    console.error('\n[DATABASE_INIT_ERROR]', databaseState.message);
    console.error(err.message || err);
    return false;
  }
}

export async function getSetting(key, fallback = '') {
  const envValue = process.env[key];
  if (!pool || !databaseState.connected) return (envValue && String(envValue).trim()) ? envValue : fallback;
  const { rows } = await query('SELECT value FROM settings WHERE key=$1', [key]);
  const dbValue = rows[0]?.value;
  if (dbValue !== undefined && dbValue !== null && String(dbValue).trim() !== '') return dbValue;
  if (envValue !== undefined && envValue !== null && String(envValue).trim() !== '') return envValue;
  return fallback;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, value ?? '']
  );
}
