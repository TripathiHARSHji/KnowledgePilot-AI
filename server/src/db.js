const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString,
  ssl: shouldUseSsl(connectionString)
    ? {
        rejectUnauthorized: false,
      }
    : false,
});

async function initDatabase() {
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
}

async function closeDatabase() {
  await pool.end();
}

async function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') {
    return false;
  }

  if (process.env.DATABASE_SSL === 'true') {
    return true;
  }

  return !databaseUrl.includes('localhost') && !databaseUrl.includes('@postgres:');
}

module.exports = {
  closeDatabase,
  getClient,
  initDatabase,
  query,
};