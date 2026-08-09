// NEW: only load .env locally. In production (Railway), env vars are
// injected by the platform — requiring dotenv there is unnecessary,
// and this guard also means dotenv doesn't need to be a production
// dependency at all.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { buildApp } = require('./src/app');
const { initDatabase, closeDatabase } = require('./src/db');

// NEW: Railway assigns a random port at runtime via process.env.PORT.
// 8080 is only a local fallback for `node server/index.js` outside
// a container.
const PORT = Number(process.env.PORT) || 8080;

async function start() {
  await initDatabase();

  const app = buildApp();

  const server = app.listen(PORT, () => {
    console.log(`KnowledgePilot AI server listening on port ${PORT}`);
  });

  async function shutdown(signal) {
    console.log(`${signal} received — shutting down gracefully`);

    server.close(async () => {
      try {
        await closeDatabase();
      } catch (error) {
        console.error('Error while closing database connection', error);
      } finally {
        process.exit(0);
      }
    });

    // Force-exit if connections don't close within 10s (e.g. a
    // Railway deploy/restart shouldn't hang indefinitely).
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});