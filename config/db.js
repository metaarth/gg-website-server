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
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

export const query = (text, params) => pool.query(text, params);

export default pool;

