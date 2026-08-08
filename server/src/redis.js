const { createClient } = require('redis');

const redisUrl = process.env.REDIS_URL;

let client;

function getRedisClient() {
  if (!redisUrl) {
    return null;
  }

  if (!client) {
    client = createClient({
      url: redisUrl,
      socket: shouldUseTls(redisUrl)
        ? {
            tls: true,
            rejectUnauthorized: false,
          }
        : undefined,
    });

    client.on('error', (error) => {
      console.error('Redis client error', error);
    });
  }

  return client;
}

async function connectRedis() {
  const redisClient = getRedisClient();
  if (!redisClient || redisClient.isOpen) {
    return;
  }

  await redisClient.connect();
}

async function disconnectRedis() {
  const redisClient = getRedisClient();
  if (!redisClient || !redisClient.isOpen) {
    return;
  }

  await redisClient.quit();
}

async function pingRedis() {
  const redisClient = getRedisClient();
  if (!redisClient) {
    return 'disabled';
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient.ping();
}

function shouldUseTls(url) {
  return url.startsWith('rediss://');
}

module.exports = {
  connectRedis,
  disconnectRedis,
  getRedisClient,
  pingRedis,
};