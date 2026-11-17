const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('dotenv').config();

const testUri = process.env.MONGODB_TEST_URI || '';
if (testUri) {
  let databaseName = '';
  try { databaseName = decodeURIComponent(new URL(testUri).pathname.replace(/^\//, '')); }
  catch { throw new Error('MONGODB_TEST_URI must be a valid MongoDB connection URI.'); }
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error('Refusing to run API isolation tests: MONGODB_TEST_URI database name must clearly contain "test".');
  }
  process.env.MONGODB_URI = testUri;
  process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('base64url');
  process.env.VERCEL = '1';
  process.env.AUTOMATION_QUEUE_ENABLED = 'false';
}

test('authenticated API routes isolate reads and mutations by account', { skip: !testUri && 'Set MONGODB_TEST_URI to a dedicated database whose name contains test.' }, async () => {
  const mongoose = require('mongoose');
  const { getMongoOptions } = require('../src/mongoOptions');
  const models = require('../src/models');
  const { User, Job, Resume, Application, AutomationRun } = models;
  const { signToken } = require('../src/middleware/auth');
  const app = require('../src/index');
  const suffix = crypto.randomBytes(10).toString('hex');
  let server;
  const users = [];

  try {
    await mongoose.connect(testUri, getMongoOptions());
    await Promise.all([User.init(), Job.init(), Resume.init(), Application.init(), AutomationRun.init()]);
    const [userA, userB] = await User.create([
      { email: `isolation-a-${suffix}@example.test`, password: crypto.randomBytes(16).toString('hex'), name: 'Isolation A' },
      { email: `isolation-b-${suffix}@example.test`, password: crypto.randomBytes(16).toString('hex'), name: 'Isolation B' },
    ]);
    users.push(userA._id, userB._id);

    const [jobA, jobB] = await Job.create([
      { userId: userA._id, jobId: `isolation-a-${suffix}`, title: 'Candidate A role', company: 'Company A', applyLink: 'https://example.test/a', matchScore: 90 },
      { userId: userB._id, jobId: `isolation-b-${suffix}`, title: 'Candidate B role', company: 'Company B', applyLink: 'https://example.test/b', matchScore: 90 },
    ]);
    const [resumeA, resumeB] = await Resume.create([
      { userId: userA._id, name: 'Resume A', email: `resume-a-${suffix}@example.test`, rawText: 'private resume A' },
      { userId: userB._id, name: 'Resume B', email: `resume-b-${suffix}@example.test`, rawText: 'private resume B' },
    ]);
    const [applicationA, applicationB] = await Application.create([
      { userId: userA._id, jobId: jobA._id, company: 'Company A', title: 'Candidate A role', notes: 'private application A' },
      { userId: userB._id, jobId: jobB._id, company: 'Company B', title: 'Candidate B role', notes: 'private application B' },
    ]);
    const runB = await AutomationRun.create({ userId: userB._id, type: 'job-hunt', status: 'queued', step: 'queued' });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const request = (token, path, options = {}) => fetch(`${base}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    const tokenA = signToken(String(userA._id));

    const resumeResponse = await request(tokenA, '/resume');
    assert.equal(resumeResponse.status, 200);
    const resumeBody = await resumeResponse.json();
    assert.equal(String(resumeBody.resume._id), String(resumeA._id));
    assert.equal(resumeBody.resume.email, resumeA.email);

    const jobsResponse = await request(tokenA, '/jobs');
    assert.equal(jobsResponse.status, 200);
    const jobsBody = await jobsResponse.json();
    assert.deepEqual(jobsBody.jobs.map(job => job.jobId), [jobA.jobId]);

    const applicationsResponse = await request(tokenA, '/applications');
    assert.equal(applicationsResponse.status, 200);
    const applicationsBody = await applicationsResponse.json();
    assert.deepEqual(applicationsBody.applications.map(item => String(item._id)), [String(applicationA._id)]);

    const foreignRunResponse = await request(tokenA, `/automation/runs/${runB._id}`);
    assert.equal(foreignRunResponse.status, 404);

    const foreignJobUpdate = await request(tokenA, `/jobs/${jobB._id}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: 'applied' }),
    });
    assert.equal(foreignJobUpdate.status, 404);

    const foreignApplicationUpdate = await request(tokenA, `/applications/${applicationB._id}`, {
      method: 'PATCH', body: JSON.stringify({ notes: `tampered-${suffix}` }),
    });
    assert.equal(foreignApplicationUpdate.status, 404);
    const foreignApplicationDelete = await request(tokenA, `/applications/${applicationB._id}`, { method: 'DELETE' });
    assert.equal(foreignApplicationDelete.status, 404);

    assert.equal((await Job.findById(jobB._id).lean()).status, 'found');
    assert.equal((await Application.findById(applicationB._id).lean()).notes, 'private application B');
    assert.ok(await Resume.exists({ _id: resumeB._id, userId: userB._id }));
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    if (users.length) {
      await Promise.all([
        Job.deleteMany({ userId: { $in: users } }),
        Resume.deleteMany({ userId: { $in: users } }),
        Application.deleteMany({ userId: { $in: users } }),
        AutomationRun.deleteMany({ userId: { $in: users } }),
        User.deleteMany({ _id: { $in: users } }),
      ]);
    }
    await mongoose.disconnect();
  }
});
