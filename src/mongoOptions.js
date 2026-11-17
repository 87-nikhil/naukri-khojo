const DEFAULT_MAX_POOL_SIZE = 10;
const MIN_MAX_POOL_SIZE = 1;
const MAX_MAX_POOL_SIZE = 100;

function boundedIntegerFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function getMongoOptions() {
  return {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: boundedIntegerFromEnv('MONGODB_MAX_POOL_SIZE', DEFAULT_MAX_POOL_SIZE, MIN_MAX_POOL_SIZE, MAX_MAX_POOL_SIZE),
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    waitQueueTimeoutMS: 10_000,
  };
}

module.exports = { getMongoOptions };
