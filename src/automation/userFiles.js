// Private per-user file storage. MongoDB GridFS is the shared durable copy;
// scoped local files are materialized for Playwright and remain the local fallback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const store = require('./store');
const { connectQueueDb } = require('../automationQueue');

const BUCKET = 'automationFiles';
let indexPromise = null;

function validName(name) { return typeof name === 'string' && /^[a-z\d_. ()-]{1,200}$/i.test(name) && name !== '.' && name !== '..'; }
function assertFileOwner(userId) {
  if (!userId || String(store.currentUserId() || '') !== String(userId)) {
    throw new Error('Private file access is outside the authenticated account scope.');
  }
}
function localPath(kind, name) {
  if (!validName(name) || !['resume', 'evidence', 'report'].includes(kind)) throw new Error('Invalid private file reference.');
  const base = kind === 'resume'
    ? store.ensureAccountDirectory()
    : store.ensurePrivateDirectory(kind === 'report' ? 'reports' : 'evidence');
  const file = path.join(base, name);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('Private automation file must be a regular, unlinked file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
function writeLocalFile(kind, name, buffer, { exclusive = false } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Private file content must be a buffer.');
  const destination = localPath(kind, name);
  if (exclusive) {
    fs.writeFileSync(destination, buffer, { mode: 0o600, flag: 'wx' });
    return destination;
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return destination;
}
async function bucketFor(userId) {
  if (userId) assertFileOwner(userId);
  if (!process.env.MONGODB_URI || !userId) return null;
  await connectQueueDb();
  if (!indexPromise) {
    indexPromise = mongoose.connection.db.collection(`${BUCKET}.files`)
      .createIndex({ 'metadata.userId': 1, 'metadata.kind': 1, 'metadata.logicalName': 1, uploadDate: -1 })
      .catch(error => { indexPromise = null; throw error; });
  }
  await indexPromise;
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
}

async function saveFile(name, kind, buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Private file content must be a buffer.');
  const dest = localPath(kind, name);
  const userId = store.currentUserId();
  const bucket = await bucketFor(userId);
  writeLocalFile(kind, name, buffer);
  if (bucket) {
    const previous = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': kind, 'metadata.logicalName': name }).toArray();
    const stat = fs.statSync(dest);
    const upload = bucket.openUploadStream(name, {
      metadata: {
        userId: String(userId), kind, logicalName: name, contentType: contentType || 'application/octet-stream',
        byteLength: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), localMtimeMs: stat.mtimeMs,
      },
    });
    await new Promise((resolve, reject) => {
      upload.once('error', reject);
      upload.once('finish', resolve);
      upload.end(buffer);
    });
    await Promise.all(previous.map(file => bucket.delete(file._id).catch(() => {})));
  }
  return name;
}

async function findSharedFile(userId, kind, name) {
  assertFileOwner(userId);
  const bucket = await bucketFor(userId);
  if (!bucket) return null;
  const [file] = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': kind, 'metadata.logicalName': name })
    .sort({ uploadDate: -1 }).limit(1).toArray();
  if (!file) return null;
  const chunks = [];
  for await (const chunk of bucket.openDownloadStream(file._id)) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType: file.metadata?.contentType || 'application/octet-stream' };
}

async function ensureLocalFile(name, kind) {
  const dest = localPath(kind, name);
  if (fs.existsSync(dest)) return dest;
  const userId = store.currentUserId();
  const shared = await findSharedFile(userId, kind, name);
  if (!shared) return null;
  writeLocalFile(kind, name, shared.buffer, { exclusive: true });
  return dest;
}

async function ensureSharedFile(name, kind) {
  const userId = store.currentUserId();
  const bucket = await bucketFor(userId);
  if (!bucket) return false;
  const local = localPath(kind, name);
  if (!fs.existsSync(local)) return false;
  const [existing] = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': kind, 'metadata.logicalName': name }).sort({ uploadDate: -1 }).limit(1).toArray();
  const stat = fs.statSync(local);
  if (kind !== 'report' && existing && Number(existing.metadata?.byteLength) === stat.size && Number(existing.metadata?.localMtimeMs) === stat.mtimeMs) return true;
  const buffer = fs.readFileSync(local);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (existing && existing.metadata?.sha256 === digest) return true;
  const contentType = kind === 'evidence' ? 'image/png' : kind === 'report'
    ? (name.endsWith('.json') ? 'application/json' : name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8')
    : 'application/octet-stream';
  await saveFile(name, kind, buffer, contentType);
  return true;
}

async function listSharedFiles(userId, kind) {
  assertFileOwner(userId);
  const bucket = await bucketFor(userId);
  if (!bucket) return [];
  const files = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': kind }, { projection: { 'metadata.logicalName': 1 } }).sort({ uploadDate: -1 }).toArray();
  return [...new Set(files.map(file => file.metadata?.logicalName).filter(validName))];
}

module.exports = { saveFile, findSharedFile, ensureLocalFile, ensureSharedFile, listSharedFiles, localPath, writeLocalFile };
