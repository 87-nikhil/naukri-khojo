const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertLocalWorkerIdle, assertOwnerBinding, contactRecords, localPrivateFiles, splitState } = require('../scripts/migrate-local-automation.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-khojo-migration-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('migration requires the selected profile and portal-owner marker to identify the same user', () => {
  const userA = '64b000000000000000000001';
  const userB = '64b000000000000000000002';
  assertOwnerBinding({ userId: userA }, { portalUserId: userA }, userA);
  assert.throws(() => assertOwnerBinding(null, { portalUserId: userA }), /portal-owner/);
  assert.throws(() => assertOwnerBinding({ userId: userA }, { portalUserId: userB }), /do not match/);
  assert.throws(() => assertOwnerBinding({ userId: userA }, { portalUserId: userA }, userB), /different portal account/);
});

test('migration deduplicates contacts by normalized email and merges their history', () => {
  const records = contactRecords([
    { id: 'first', email: 'Recruiter@Example.test', name: 'Recruiter', companies: ['A'], sourceFiles: ['one.xlsx'], importCount: 2 },
    { id: 'duplicate', email: 'recruiter@example.test', companies: ['B'], sourceFiles: ['two.xlsx'], importCount: 3 },
    { id: 'invalid', email: 'not-an-email' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].contactId, 'first');
  assert.equal(records[0].emailNormalized, 'recruiter@example.test');
  assert.deepEqual(records[0].companies, ['A', 'B']);
  assert.deepEqual(records[0].sourceFiles, ['one.xlsx', 'two.xlsx']);
  assert.equal(records[0].importCount, 5);
  assert.throws(() => contactRecords({}), /must contain an array/);
});

test('migration splits account state and job descriptions into deterministic owner data', () => {
  const state = {
    settings: { paused: true }, answers: { '*|*|location': 'Pune' }, excludedCompanies: ['Blocked Co'],
    runs: [{ id: 'run-1' }], events: [{ message: 'local event' }], customSetting: { keep: true },
    jobs: [
      { id: 'job:one', title: 'One', description: 'Private description' },
      { id: 'job:two', title: 'Two', description: '' },
    ],
  };
  const split = splitState(state);
  assert.equal(split.jobs.length, 2);
  assert.equal('jobs' in split.accountState, false);
  assert.deepEqual(split.accountState.extra, { customSetting: { keep: true } });
  assert.equal(split.jobs[0].data.description, undefined);
  assert.match(split.jobs[0].descriptionFile, /^job-[a-f\d]{32}\.txt$/);
  assert.equal(split.descriptions[0].buffer.toString(), 'Private description');
  assert.equal(split.descriptions[0].name, `job-${crypto.createHash('sha256').update('job:one').digest('hex').slice(0, 32)}.txt`);
  assert.throws(() => splitState({ jobs: [{ id: '../foreign-user' }] }), /invalid id/);
  assert.throws(() => splitState({ custom: 'x'.repeat(8 * 1024 * 1024) }), /exceed 8 MB/);
});

test('migration includes only supported private files and rejects unsafe resume references', () => {
  const dataDir = path.join(root, 'private-files');
  fs.mkdirSync(path.join(dataDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'candidate.pdf'), 'fake resume');
  fs.mkdirSync(path.join(dataDir, 'folder.pdf'));
  fs.writeFileSync(path.join(dataDir, 'candidate.DOCX'), 'fake docx');
  fs.writeFileSync(path.join(dataDir, 'evidence', 'shot-1.png'), 'fake evidence');
  fs.writeFileSync(path.join(dataDir, 'evidence', 'ignore.txt'), 'ignore');
  fs.writeFileSync(path.join(dataDir, 'reports', '2026-11-17.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'reports', '2026-11-18.JSON'), '{}');
  fs.writeFileSync(path.join(dataDir, 'reports', 'secrets.txt'), 'ignore');

  const files = localPrivateFiles(dataDir, { resumeFile: 'candidate.pdf' });
  assert.deepEqual(files.map(file => file.kind).sort(), ['evidence', 'report', 'report', 'resume']);
  assert.equal(files.find(file => file.name === 'candidate.pdf').contentType, 'application/pdf');
  assert.equal(localPrivateFiles(dataDir, { resumeFile: 'candidate.DOCX' })[0].contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(files.find(file => file.name === '2026-11-18.JSON').contentType, 'application/json');
  assert.throws(() => localPrivateFiles(dataDir, { resumeFile: '../candidate.pdf' }), /resume reference is invalid/);
  assert.throws(() => localPrivateFiles(dataDir, { resumeFile: 'missing.pdf' }), /resume file is missing/);
  assert.throws(() => localPrivateFiles(dataDir, { resumeFile: 'folder.pdf' }), /regular file/);
});

test('migration refuses evidence and reports directories linked outside the selected account directory', () => {
  for (const directory of ['evidence', 'reports']) {
    const dataDir = path.join(root, `linked-${directory}`);
    const outsideDir = path.join(root, `outside-${directory}`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, directory === 'evidence' ? 'shot-2.png' : '2026-11-19.json'), 'private external file');
    try {
      fs.symlinkSync(outsideDir, path.join(dataDir, directory), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        assert.fail(`Could not create the directory junction needed for this security test: ${error.message}`);
      }
      throw error;
    }
    assert.throws(() => localPrivateFiles(dataDir, {}), new RegExp(`local ${directory} path must be a real directory`));
  }
});

test('apply migration refuses an active or malformed local worker lock', () => {
  const dataDir = path.join(root, 'worker-lock');
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'worker.lock');
  fs.writeFileSync(lockFile, String(process.pid));
  assert.throws(() => assertLocalWorkerIdle(dataDir), /worker PID .* is active/);
  fs.writeFileSync(lockFile, 'not-a-pid');
  assert.throws(() => assertLocalWorkerIdle(dataDir), /worker lock is invalid/);
  fs.unlinkSync(lockFile);
  assert.doesNotThrow(() => assertLocalWorkerIdle(dataDir));
});
