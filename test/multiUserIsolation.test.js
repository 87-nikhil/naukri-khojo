const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-khojo-multi-user-'));
process.env.AUTOMATION_DATA_DIR = dataRoot;
const store = require('../src/automation/store');
const userFiles = require('../src/automation/userFiles');
const userA = '64b000000000000000000001';
const userB = '64b000000000000000000002';
const legacyUser = '64b000000000000000000003';
const symlinkUser = '64b000000000000000000004';

after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

test('parallel account scopes persist profiles and jobs in separate directories', async () => {
  await Promise.all([
    store.runAsUser(userA, async () => {
      store.write('profile', { name: 'Candidate A' });
      await new Promise(resolve => setTimeout(resolve, 10));
      store.mutate(state => { state.jobs.push({ id: 'job-a' }); });
      assert.equal(store.currentUserId(), userA);
    }),
    store.runAsUser(userB, async () => {
      store.write('profile', { name: 'Candidate B' });
      await new Promise(resolve => setTimeout(resolve, 5));
      store.mutate(state => { state.jobs.push({ id: 'job-b' }); });
      assert.equal(store.currentUserId(), userB);
    }),
  ]);

  const profileA = await store.runAsUser(userA, () => store.read('profile'));
  const profileB = await store.runAsUser(userB, () => store.read('profile'));
  const jobsA = await store.runAsUser(userA, () => store.state().jobs);
  const jobsB = await store.runAsUser(userB, () => store.state().jobs);
  assert.deepEqual(profileA, { name: 'Candidate A' });
  assert.deepEqual(profileB, { name: 'Candidate B' });
  assert.deepEqual(jobsA.map(job => job.id), ['job-a']);
  assert.deepEqual(jobsB.map(job => job.id), ['job-b']);

  const digestA = crypto.createHash('sha256').update(userA).digest('hex');
  const digestB = crypto.createHash('sha256').update(userB).digest('hex');
  assert.notEqual(digestA, digestB);
  assert.ok(fs.existsSync(path.join(dataRoot, 'users', digestA, 'profile.json')));
  assert.ok(fs.existsSync(path.join(dataRoot, 'users', digestB, 'profile.json')));
});

test('the legacy owner keeps the original local automation directory', async () => {
  fs.writeFileSync(path.join(dataRoot, 'portal-owner.json'), JSON.stringify({ userId: legacyUser }));
  await store.runAsUser(legacyUser, () => store.write('profile', { name: 'Legacy candidate' }));
  await store.runAsUser(userB, () => store.write('profile', { name: 'Separate candidate' }));

  assert.deepEqual(store.read('profile'), { name: 'Legacy candidate' });
  assert.deepEqual(await store.runAsUser(userB, () => store.read('profile')), { name: 'Separate candidate' });
  assert.ok(!fs.existsSync(path.join(dataRoot, 'users', crypto.createHash('sha256').update(legacyUser).digest('hex'), 'profile.json')));
});

test('invalid account IDs are rejected before building a filesystem scope', () => {
  assert.throws(() => store.runAsUser('../another-user', () => {}), /Invalid automation account scope/);
});

test('account scopes reject linked tenant directories and scheduler discovery skips them', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-khojo-linked-user-'));
  const usersRoot = path.join(dataRoot, 'users');
  const tenantPath = path.join(usersRoot, crypto.createHash('sha256').update(symlinkUser).digest('hex'));
  fs.mkdirSync(usersRoot, { recursive: true });
  fs.writeFileSync(path.join(outside, 'portal-owner.json'), JSON.stringify({ userId: symlinkUser }));
  fs.writeFileSync(path.join(outside, 'profile.json'), JSON.stringify({ name: 'Must not be read or changed' }));
  try {
    fs.symlinkSync(outside, tenantPath, 'junction');
  } catch (error) {
    fs.rmSync(outside, { recursive: true, force: true });
    assert.fail(`Could not create the directory junction needed for this security test: ${error.message}`);
  }
  try {
    assert.throws(() => store.runAsUser(symlinkUser, () => store.read('profile', null)), /account directory must be a real directory/);
    assert.ok(!store.listUserIds().includes(symlinkUser));
  } finally {
    fs.rmSync(tenantPath, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('private reports and evidence cannot follow links into another account directory', () => {
  for (const [kind, directory] of [['report', 'reports'], ['evidence', 'evidence']]) {
    const sourceDir = store.runAsUser(userB, () => store.ensurePrivateDirectory(directory));
    const targetRoot = store.runAsUser(userA, () => store.ensureAccountDirectory());
    const linkedDir = path.join(targetRoot, directory);
    fs.writeFileSync(path.join(sourceDir, kind === 'report' ? '2026-11-20.json' : 'shot-foreign.png'), 'private account file');
    try {
      fs.symlinkSync(sourceDir, linkedDir, 'junction');
    } catch (error) {
      assert.fail(`Could not create the directory junction needed for this security test: ${error.message}`);
    }
    try {
      assert.throws(() => store.runAsUser(userA, () => userFiles.localPath(kind, kind === 'report' ? '2026-11-20.json' : 'shot-foreign.png')), /directory must be a real directory/);
    } finally {
      fs.rmSync(linkedDir, { recursive: true, force: true });
    }
  }
});

test('private file reads and writes reject symlinked report targets', t => {
  const source = store.runAsUser(userB, () => userFiles.localPath('report', '2026-11-21.json'));
  const destination = store.runAsUser(userA, () => userFiles.localPath('report', '2026-11-21.json'));
  fs.writeFileSync(source, 'account B report');
  try {
    fs.symlinkSync(source, destination, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`File symlinks are unavailable in this environment: ${error.message}`);
      return;
    }
    throw error;
  }
  try {
    assert.throws(() => store.runAsUser(userA, () => userFiles.localPath('report', '2026-11-21.json')), /must be a regular file/);
    assert.throws(() => store.runAsUser(userA, () => userFiles.writeLocalFile('report', '2026-11-21.json', Buffer.from('overwritten'))), /must be a regular file/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'account B report');
  } finally {
    fs.unlinkSync(destination);
  }
});

test('private report writes cannot overwrite another account through a hard link', () => {
  const source = store.runAsUser(userB, () => userFiles.localPath('report', '2026-11-22.json'));
  const destination = store.runAsUser(userA, () => userFiles.localPath('report', '2026-11-22.json'));
  fs.writeFileSync(source, 'account B report');
  fs.linkSync(source, destination);
  try {
    assert.throws(() => store.runAsUser(userA, () => userFiles.localPath('report', '2026-11-22.json')), /regular, unlinked file/);
    assert.throws(() => store.runAsUser(userA, () => userFiles.writeLocalFile('report', '2026-11-22.json', Buffer.from('overwritten'))), /regular, unlinked file/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'account B report');
  } finally {
    fs.unlinkSync(destination);
  }
});
