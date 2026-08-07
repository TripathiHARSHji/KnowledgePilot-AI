const { query } = require('../db');
const { pingRedis } = require('../redis');

async function getHealthSnapshot() {
  await query('SELECT 1');
  const redis = await pingRedis();

  return {
    status: 'ok',
    services: {
      postgres: 'ok',
      redis,
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getHealthSnapshot,
};