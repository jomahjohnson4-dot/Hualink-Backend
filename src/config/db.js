// src/config/db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Add connection details or environment variables here
});

export default {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};