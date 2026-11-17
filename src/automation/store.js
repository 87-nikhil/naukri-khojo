const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const BASE_ROOT = path.resolve(process.env.AUTOMATION_DATA_DIR || path.join(__dirname, '../../.automation'));
const scope = new AsyncLocalStorage();
function tenantRoot(userId) { return path.join(BASE_ROOT, 'users', crypto.createHash('sha256').update(String(userId)).digest('hex')); }
function ensureDirectory(directory, label) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Automation ${label} must be a real directory; symbolic links are not allowed.`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Automation ${label} must be a real directory; symbolic links are not allowed.`);
}
function currentRoot(userId = scope.getStore()) {
  if (!userId) return BASE_ROOT;
  // Keep the existing local account in its current directory. Other portal
  // accounts receive independent, non-guessable directories beneath the store.
  const legacyOwner = readAt(BASE_ROOT, 'portal-owner', null);
  return String(legacyOwner?.userId || '') === String(userId) ? BASE_ROOT : tenantRoot(userId);
}
function ensure() {
  const root = currentRoot();
  if (root !== BASE_ROOT) ensureDirectory(path.join(BASE_ROOT, 'users'), 'account directory parent');
  if (root !== BASE_ROOT) ensureDirectory(root, 'account directory');
  else fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}
function ensureAccountDirectory() {
  ensure();
  return currentRoot();
}
function ensurePrivateDirectory(name) {
  if (!['reports', 'evidence'].includes(name)) throw new Error('Invalid private automation directory.');
  ensure();
  const directory = path.join(currentRoot(), name);
  ensureDirectory(directory, `${name} directory`);
  return directory;
}
function readAt(root, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function read(name, fallback) {
  ensure();
  return readAt(currentRoot(), name, fallback);
}
function write(name, value) {
  ensure();
  const dest = path.join(currentRoot(), `${name}.json`);
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return value;
}
function state() { return read('state', { jobs: [], runs: [], events: [], answers: {}, excludedCompanies: [], settings: { autoApply: true, dailyTarget: 15, paused: false, headless: true, quietHours: { start: 21, end: 3 }, skipAts: ['linkedin'] } }); }
function mutate(fn) { const value = state(); fn(value); write('state', value); return value; }
function event(message) { mutate(s => { s.events.unshift({ time: new Date().toISOString(), message }); s.events = s.events.slice(0, 300); }); }
function indiaDay(date = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function runAsUser(userId, callback) {
  if (!userId || !/^[a-z\d_-]{1,128}$/i.test(String(userId))) throw new Error('Invalid automation account scope');
  return scope.run(String(userId), callback);
}
function currentUserId() { return scope.getStore() || null; }
function prepareUserScope(userId, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const legacyOwner = readAt(BASE_ROOT, 'portal-owner', null);
  const legacyProfile = readAt(BASE_ROOT, 'profile', null);
  if (legacyOwner && String(legacyOwner.userId) !== String(userId)) {
    const profileMatchesOwner = String(legacyProfile?.portalUserId || '') === String(legacyOwner.userId);
    const accountRecovery = profileMatchesOwner && normalizedEmail &&
      String(legacyOwner.email || '').trim().toLowerCase() === normalizedEmail;
    if (!accountRecovery) return tenantRoot(userId);
    const tenantOwner = readAt(tenantRoot(userId), 'portal-owner', null);
    const tenantProfile = readAt(tenantRoot(userId), 'profile', null);
    if (String(tenantOwner?.userId || '') === String(userId) || String(tenantProfile?.portalUserId || '') === String(userId)) {
      return tenantRoot(userId);
    }
    writeAt(BASE_ROOT, 'portal-owner', { ...legacyOwner, userId: String(userId), linkedAt: new Date().toISOString() });
    return BASE_ROOT;
  }
  if (!legacyOwner && legacyProfile) {
    const profileUserMatches = String(legacyProfile.portalUserId || '') === String(userId);
    const profileEmailMatches = normalizedEmail && [legacyProfile.email, legacyProfile.accountEmail]
      .some(value => String(value || '').trim().toLowerCase() === normalizedEmail);
    if (profileUserMatches || profileEmailMatches) {
      writeAt(BASE_ROOT, 'portal-owner', { userId: String(userId), email: normalizedEmail, linkedAt: new Date().toISOString() });
      return BASE_ROOT;
    }
  }
  return currentRoot(String(userId));
}
function listUserIds() {
  const roots = [BASE_ROOT];
  const usersRoot = path.join(BASE_ROOT, 'users');
  try {
    const usersStat = fs.lstatSync(usersRoot);
    if (!usersStat.isDirectory() || usersStat.isSymbolicLink()) return [...new Set(roots.map(root => readAt(root, 'portal-owner', null)?.userId).filter(userId => /^[a-z\d_-]{1,128}$/i.test(String(userId || ''))).map(String))];
    for (const name of fs.readdirSync(usersRoot)) {
      const candidate = path.join(usersRoot, name);
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isDirectory() && !stat.isSymbolicLink()) roots.push(candidate);
      } catch { /* skip removed entries */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...new Set(roots.map(root => readAt(root, 'portal-owner', null)?.userId).filter(userId => /^[a-z\d_-]{1,128}$/i.test(String(userId || ''))).map(String))];
}
function writeAt(root, name, value) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dest = path.join(root, `${name}.json`), tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
}
function acquireLock() {
  ensure();
  const file = path.join(currentRoot(), 'worker.lock');
  try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(file); return acquireLock(); } throw e; }
    throw new Error('Another automation worker is already running');
  }
  return () => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
}
function workerActive() {
  const file = path.join(currentRoot(), 'worker.lock');
  if (!fs.existsSync(file)) return false;
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
Object.defineProperty(module.exports, 'ROOT', { enumerable: true, get: currentRoot });
Object.assign(module.exports, { BASE_ROOT, read, write, state, mutate, event, indiaDay, acquireLock, workerActive, runAsUser, currentUserId, prepareUserScope, listUserIds, ensureAccountDirectory, ensurePrivateDirectory });
