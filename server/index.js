require('dotenv').config();

const { buildApp } = require('./src/app');
const { initDatabase, closeDatabase } = require('./src/db');
const { connectRedis, disconnectRedis } = require('./src/redis');

const port = Number(process.env.PORT || 8080);

async function start() {
  await initDatabase();
  await connectRedis();

  const app = buildApp();
  const server = app.listen(port, () => {
    console.log(`KnowledgePilot server listening on port ${port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await Promise.allSettled([closeDatabase(), disconnectRedis()]);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});