const crypto = require('node:crypto');
const store = require('./store');

const MARKER = 'aes-256-gcm-v1';
function encryptionKey() {
  const secret = String(process.env.AUTOMATION_CREDENTIAL_KEY || '');
  if (!secret) return null;
  if (Buffer.byteLength(secret) < 32) throw new Error('AUTOMATION_CREDENTIAL_KEY must contain at least 32 bytes.');
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const key = encryptionKey();
  if (!key) throw new Error('Set AUTOMATION_CREDENTIAL_KEY before saving encrypted automation credentials.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: MARKER, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function decrypt(envelope) {
  if (!envelope || envelope.version !== MARKER) throw new Error('Saved automation credentials have an unsupported encrypted format.');
  const key = encryptionKey();
  if (!key) throw new Error('Set AUTOMATION_CREDENTIAL_KEY to access saved automation credentials.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(clear);
  } catch {
    throw new Error('Could not decrypt saved automation credentials. Check that AUTOMATION_CREDENTIAL_KEY matches the key used to save them.');
  }
}

function readLocal() {
  const saved = store.read('email-connection', null);
  if (!saved) return null;
  if (saved.version === MARKER) return decrypt(saved);
  // Migrate older plaintext local credentials in place when encryption is configured.
  if (encryptionKey()) store.write('email-connection', encrypt(saved));
  return saved;
}

function writeLocal(value) {
  const key = encryptionKey();
  store.write('email-connection', key ? encrypt(value) : value);
  return value;
}

module.exports = { encrypt, decrypt, readLocal, writeLocal, isConfigured: () => !!encryptionKey() };
