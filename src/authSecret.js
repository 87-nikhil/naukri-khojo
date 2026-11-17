const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function localSecret() {
  const dataDir = path.resolve(process.env.AUTOMATION_DATA_DIR || path.join(__dirname, '../.automation'));
  const filename = path.join(dataDir, 'portal-jwt-secret');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    const secret = fs.readFileSync(filename, 'utf8').trim();
    if (secret.length >= 32) return secret;
    throw new Error('The local portal signing key is invalid. Remove portal-jwt-secret and restart the server to create a new one.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  try { fs.writeFileSync(filename, secret, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFileSync(filename, 'utf8').trim();
}

const configuredSecret = String(process.env.JWT_SECRET || '').trim();
const hosted = process.env.VERCEL || process.env.NODE_ENV === 'production';
if (hosted && !configuredSecret) {
  throw new Error('JWT_SECRET must be configured in every hosted environment and shared by all app and automation instances.');
}
if (configuredSecret && configuredSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}

const JWT_SECRET = configuredSecret || localSecret();

module.exports = { JWT_SECRET };
