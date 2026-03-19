import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Missing DATABASE_URL in environment variables');
  throw new Error('DATABASE_URL is required for PostgreSQL connection');
}

const pool = new Pool({
  connectionString,
  // AWS RDS often enforces SSL. node-postgres does not automatically honor `sslmode=require`
  // from the connection string, so we enable SSL based on common signals.
  ssl:
    String(process.env.PGSSLMODE || '').toLowerCase() === 'require' ||
    /sslmode=require/i.test(connectionString) ||
    /rds\.amazonaws\.com/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

export const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('PostgreSQL query error:', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });
    throw err;
  }
};

export default pool;

