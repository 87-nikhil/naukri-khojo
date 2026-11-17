require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { getMongoOptions } = require('../src/mongoOptions');
const { assertTestDatabaseUri } = require('./testDatabaseGuard');

async function main() {
  const uri = process.env.MONGODB_TEST_URI;
  assertTestDatabaseUri(uri);
  const secret = String(process.env.JWT_SECRET || '');
  if (secret.length < 32) throw new Error('Set the same JWT_SECRET used by the test API (at least 32 characters).');
  const userCount = Number(process.env.LOAD_TEST_USERS || 100);
  if (!Number.isInteger(userCount) || userCount < 1 || userCount > 500) throw new Error('LOAD_TEST_USERS must be from 1 to 500.');
  const runId = crypto.randomBytes(6).toString('hex');
  const outputFile = path.resolve(process.env.LOAD_TEST_TOKENS_FILE || path.join('.automation', 'load-tests', `users-${runId}.json`));
  if (fs.existsSync(outputFile)) throw new Error('Refusing to overwrite the existing load-test token file.');

  const { User, Job, Resume, Application, AutomationRun } = require('../src/models');
  const inserted = [];
  let stopping = false;
  const requestStop = () => { stopping = true; };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  const deleteSeededData = async () => {
    if (!inserted.length) return;
    const filter = { userId: { $in: inserted } };
    await Promise.all([
      Job.deleteMany(filter), Resume.deleteMany(filter), Application.deleteMany(filter),
      AutomationRun.deleteMany(filter), User.deleteMany({ _id: { $in: inserted } }),
    ]);
  };
  try {
    await mongoose.connect(uri, getMongoOptions());
    await Promise.all([User.init(), Job.init(), Resume.init(), Application.init(), AutomationRun.init()]);
    const password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const users = [];
    for (let i = 1; i <= userCount; i++) {
      if (stopping) throw new Error('Load-test seed cancelled; removing synthetic records created so far.');
      const email = `loadtest-${runId}-${String(i).padStart(3, '0')}@example.test`;
      const user = await User.create({ email, password, name: `Load Test ${i}`, isAdmin: false });
      inserted.push(user._id);
      const jobs = await Job.insertMany(Array.from({ length: 20 }, (_, index) => ({
        userId: user._id,
        jobId: `loadtest-${runId}-${String(i).padStart(3, '0')}-job-${String(index + 1).padStart(2, '0')}`,
        title: `Synthetic Software Engineer ${index + 1}`,
        company: `Load Test Company ${index % 5 + 1}`,
        location: index % 2 ? 'Pune, India' : 'Remote, India',
        skills: ['Node.js', 'MongoDB', 'JavaScript'],
        experience: '3-6 years',
        applyLink: `https://example.test/${runId}/user-${i}/job-${index + 1}`,
        source: 'Other',
        description: 'Synthetic load-test posting. No real employer or application is involved.',
        matchScore: 60 + index % 40,
        status: index < 5 ? 'applied' : 'found',
      })));
      await Resume.create({
        userId: user._id,
        name: `Load Test ${i}`,
        email,
        skills: ['Node.js', 'MongoDB', 'JavaScript'],
        experience: 5,
        roles: ['Software Engineer'],
        rawText: 'Synthetic load-test resume. Contains no real candidate information.',
      });
      await Application.insertMany(jobs.slice(0, 5).map(job => ({
        userId: user._id,
        jobId: job._id,
        company: job.company,
        title: job.title,
        location: job.location,
        source: 'Other',
        applyLink: job.applyLink,
        matchScore: job.matchScore,
        status: 'applied',
      })));
      await AutomationRun.insertMany([
        { userId: user._id, type: 'job-hunt', status: 'complete', step: 'complete', progress: 100, createdAt: new Date(Date.now() - 60_000) },
        { userId: user._id, type: 'job-hunt', status: 'complete', step: 'complete', progress: 100, createdAt: new Date(Date.now() - 120_000) },
      ]);
      if (stopping) throw new Error('Load-test seed cancelled; removing synthetic records created so far.');
      users.push({
        userId: String(user._id),
        email,
        token: jwt.sign({ userId: String(user._id) }, secret, { expiresIn: '1d' }),
      });
    }
    fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outputFile, JSON.stringify({ runId, createdAt: new Date().toISOString(), users }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Created ${users.length} synthetic accounts with 20 jobs, five applications, one resume, and two run records each in the test database.`);
    console.log(`Token file: ${outputFile}`);
    console.log('Use this test database and the same JWT_SECRET for the API under test.');
  } catch (error) {
    await deleteSeededData().catch(() => {});
    throw error;
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    await mongoose.disconnect();
  }
}

main().catch(error => { console.error('Load-test seeding failed:', error.message); process.exitCode = 1; });
