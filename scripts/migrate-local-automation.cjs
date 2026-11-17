require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { getMongoOptions } = require('../src/mongoOptions');
const { User, AutomationProfile, AutomationContact, AutomationJob, AutomationAccountState } = require('../src/models');

const FILE_BUCKET = 'automationFiles';
const CONTACT_BATCH_SIZE = 500;
const JOB_BATCH_SIZE = 500;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
  }
}

function assertLocalWorkerIdle(dataDir) {
  const lockFile = path.join(dataDir, 'worker.lock');
  if (!fs.existsSync(lockFile)) return;
  const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('The local worker lock is invalid; stop the automation service and inspect worker.lock before migrating.');
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    throw new Error('Could not verify whether the local automation worker is active; stop the service before applying the migration.');
  }
  throw new Error(`Local automation worker PID ${pid} is active; stop it before applying a migration.`);
}

function assertOwnerBinding(owner, profile, selectedUserId = null) {
  if (!owner?.userId || !profile?.portalUserId) throw new Error('The local data needs a verified portal-owner.json and a profile linked through portal SSO.');
  if (String(owner.userId) !== String(profile.portalUserId)) throw new Error('Local owner and profile portal account IDs do not match; refusing to migrate.');
  if (selectedUserId && String(owner.userId) !== String(selectedUserId)) throw new Error('The selected local data directory belongs to a different portal account.');
}

function contactRecords(values) {
  if (!Array.isArray(values)) throw new Error('The local company-contacts.json must contain an array.');
  const deduped = new Map();
  for (const item of values) {
    const email = String(item?.email || '').trim();
    const emailNormalized = String(item?.emailNormalized || email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) continue;
    const current = deduped.get(emailNormalized);
    if (!current) {
      deduped.set(emailNormalized, {
        contactId: String(item.id || crypto.randomUUID()),
        email,
        emailNormalized,
        name: String(item.name || '').slice(0, 160),
        companies: [...new Set((Array.isArray(item.companies) ? item.companies : []).map(String).map(v => v.trim()).filter(Boolean))].slice(0, 100),
        sourceFiles: [...new Set((Array.isArray(item.sourceFiles) ? item.sourceFiles : []).map(String).map(v => v.trim()).filter(Boolean))].slice(0, 100),
        firstImportedAt: item.firstImportedAt ? new Date(item.firstImportedAt) : undefined,
        lastImportedAt: item.lastImportedAt ? new Date(item.lastImportedAt) : undefined,
        importCount: Math.max(0, Number(item.importCount) || 0),
        status: item.status === 'archived' ? 'archived' : 'active',
      });
    } else {
      if (!current.name && item.name) current.name = String(item.name).slice(0, 160);
      current.companies = [...new Set([...current.companies, ...(Array.isArray(item.companies) ? item.companies : [])].map(String).map(v => v.trim()).filter(Boolean))].slice(0, 100);
      current.sourceFiles = [...new Set([...current.sourceFiles, ...(Array.isArray(item.sourceFiles) ? item.sourceFiles : [])].map(String).map(v => v.trim()).filter(Boolean))].slice(0, 100);
      current.importCount += Math.max(0, Number(item.importCount) || 0);
      if (item.lastImportedAt && (!current.lastImportedAt || Date.parse(item.lastImportedAt) > current.lastImportedAt)) current.lastImportedAt = new Date(item.lastImportedAt);
    }
  }
  return [...deduped.values()];
}

function localPrivateFiles(dataDir, profile) {
  const candidates = [];
  if (profile.resumeFile) {
    const resumeName = path.basename(String(profile.resumeFile));
    if (resumeName !== profile.resumeFile || !/^[a-z\d_. ()-]+\.(?:pdf|docx)$/i.test(resumeName) || resumeName === '.' || resumeName === '..') throw new Error('The profile resume reference is invalid; refusing to migrate files.');
    const file = path.join(dataDir, resumeName);
    if (!fs.existsSync(file)) throw new Error('The profile resume file is missing from the selected local data directory.');
    if (!fs.lstatSync(file).isFile()) throw new Error('The profile resume reference must point to a regular file inside the local data directory.');
    candidates.push({ file, name: resumeName, kind: 'resume', contentType: resumeName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
  const evidenceDir = path.join(dataDir, 'evidence');
  if (fs.existsSync(evidenceDir)) {
    if (!fs.lstatSync(evidenceDir).isDirectory()) throw new Error('The local evidence path must be a real directory inside the selected local data directory.');
    for (const name of fs.readdirSync(evidenceDir).filter(item => /^[a-z\d-]+\.png$/i.test(item))) {
      const file = path.join(evidenceDir, name);
      if (fs.lstatSync(file).isFile()) candidates.push({ file, name, kind: 'evidence', contentType: 'image/png' });
    }
  }
  const reportsDir = path.join(dataDir, 'reports');
  if (fs.existsSync(reportsDir)) {
    if (!fs.lstatSync(reportsDir).isDirectory()) throw new Error('The local reports path must be a real directory inside the selected local data directory.');
    for (const name of fs.readdirSync(reportsDir).filter(item => /^(?:shortlist-)?\d{4}-\d{2}-\d{2}\.(?:json|csv|html)$/i.test(item))) {
      const file = path.join(reportsDir, name);
      if (!fs.lstatSync(file).isFile()) continue;
      const extension = path.extname(name).toLowerCase();
      const contentType = extension === '.json' ? 'application/json' : extension === '.csv' ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8';
      candidates.push({ file, name, kind: 'report', contentType });
    }
  }
  return candidates;
}

async function uploadPrivateFile(bucket, userId, file) {
  const [existing] = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': file.kind, 'metadata.logicalName': file.name }).limit(1).toArray();
  if (existing) return false;
  const buffer = fs.readFileSync(file.file);
  const stat = fs.statSync(file.file);
  const upload = bucket.openUploadStream(file.name, {
    metadata: {
      userId: String(userId), kind: file.kind, logicalName: file.name, contentType: file.contentType,
      byteLength: stat.size, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), localMtimeMs: stat.mtimeMs,
    },
  });
  await new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(buffer);
  });
  return true;
}

async function uploadBuffer(bucket, userId, file) {
  const [existing] = await bucket.find({ 'metadata.userId': String(userId), 'metadata.kind': file.kind, 'metadata.logicalName': file.name }).limit(1).toArray();
  if (existing) return false;
  const upload = bucket.openUploadStream(file.name, { metadata: {
    userId: String(userId), kind: file.kind, logicalName: file.name, contentType: file.contentType,
    byteLength: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  } });
  await new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(file.buffer);
  });
  return true;
}

function splitState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('The local state.json must contain an object.');
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const byId = new Map();
  const descriptionsByName = new Map();
  for (const original of jobs) {
    if (!original || typeof original !== 'object' || Array.isArray(original)) continue;
    const id = String(original.id || original.jobId || '').trim();
    if (!/^[a-z\d_.:-]{1,160}$/i.test(id)) throw new Error(`A local job has an invalid id (${id.slice(0, 40)}); refusing migration.`);
    const data = { ...original };
    const description = typeof data.description === 'string' ? data.description : '';
    delete data.description;
    let descriptionFile = null;
    if (description) {
      descriptionFile = `job-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)}.txt`;
      descriptionsByName.set(descriptionFile, { name: descriptionFile, kind: 'job-description', contentType: 'text/plain; charset=utf-8', buffer: Buffer.from(description, 'utf8') });
    }
    byId.set(id, { jobId: id, data, descriptionFile });
  }
  const { jobs: ignoredJobs, ...rest } = state;
  const accountState = {
    settings: rest.settings && typeof rest.settings === 'object' ? rest.settings : {},
    answers: rest.answers && typeof rest.answers === 'object' ? rest.answers : {},
    excludedCompanies: Array.isArray(rest.excludedCompanies) ? rest.excludedCompanies : [],
    runs: Array.isArray(rest.runs) ? rest.runs : [],
    events: Array.isArray(rest.events) ? rest.events : [],
  };
  const known = new Set(['settings', 'answers', 'excludedCompanies', 'runs', 'events']);
  accountState.extra = Object.fromEntries(Object.entries(rest).filter(([key]) => !known.has(key)));
  if (Buffer.byteLength(JSON.stringify(accountState), 'utf8') > 8 * 1024 * 1024) throw new Error('Account settings/history exceed 8 MB; trim local history before migrating. Jobs are stored separately.');
  return { jobs: [...byId.values()], accountState, descriptions: [...descriptionsByName.values()] };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dataDirIndex = process.argv.indexOf('--data-dir');
  const userIdIndex = process.argv.indexOf('--user-id');
  const selectedUserId = userIdIndex >= 0 ? process.argv[userIdIndex + 1] : null;
  if (userIdIndex >= 0 && (!selectedUserId || selectedUserId.startsWith('--'))) throw new Error('--user-id requires a portal MongoDB user ID.');
  if (selectedUserId && !/^[a-f\d]{24}$/i.test(selectedUserId)) throw new Error('--user-id must be a 24-character MongoDB ObjectId.');
  if (dataDirIndex >= 0 && selectedUserId) throw new Error('Choose either --data-dir or --user-id, not both.');
  const root = path.resolve(process.env.AUTOMATION_DATA_DIR || path.join(__dirname, '../.automation'));
  const userHash = selectedUserId ? crypto.createHash('sha256').update(String(selectedUserId)).digest('hex') : null;
  const dataDir = path.resolve(dataDirIndex >= 0
    ? process.argv[dataDirIndex + 1] || ''
    : selectedUserId ? path.join(root, 'users', userHash) : root);
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI before migrating local automation data.');

  const owner = readJson(path.join(dataDir, 'portal-owner.json'), null);
  const profile = readJson(path.join(dataDir, 'profile.json'), null);
  const localState = readJson(path.join(dataDir, 'state.json'), {});
  const localContacts = readJson(path.join(dataDir, 'company-contacts.json'), []);
  assertOwnerBinding(owner, profile, selectedUserId);
  if (apply) assertLocalWorkerIdle(dataDir);

  const contacts = contactRecords(localContacts);
  const { jobs, accountState, descriptions } = splitState(localState);
  const files = localPrivateFiles(dataDir, profile);
  await mongoose.connect(process.env.MONGODB_URI, getMongoOptions());
  try {
    const user = await User.findById(owner.userId).select('_id email automationActiveRunId automationInteractiveLeaseUntil automationContactMutationLeaseUntil').lean();
    if (!user) throw new Error('The local owner account does not exist in the configured MongoDB database.');
    if (String(user.email || '').toLowerCase() !== String(owner.email || '').toLowerCase()) throw new Error('The local owner email does not match the MongoDB account; refusing to migrate.');
    if (apply && (user.automationActiveRunId || user.automationInteractiveLeaseUntil > new Date() || user.automationContactMutationLeaseUntil > new Date())) {
      throw new Error('The account has active automation, browser, or contact work. Stop it and retry the migration.');
    }

    const existingProfile = await AutomationProfile.exists({ userId: user._id });
    const stateExists = await AutomationAccountState.exists({ userId: user._id });
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: verified one local owner, profile ${existingProfile ? 'already exists' : 'will be inserted'}, account state ${stateExists ? 'already exists' : 'will be inserted'}, ${contacts.length} unique contacts, ${jobs.length} unique jobs, and ${files.length + descriptions.length} private files ready for GridFS.`);
    console.log(`Source directory: ${dataDir}`);
    console.log('Gmail credentials are migrated during authenticated automation sign-in when AUTOMATION_CREDENTIAL_KEY is configured. Browser sessions are not copied. Queue mode reads and writes Mongo job/state data; scoped local JSON remains the worker cache. Local mode continues to use JSON as its source of truth.');
    if (!apply) {
    console.log('No database records were changed. Stop the automation service before applying the migration, then re-run with --apply.');
      return;
    }

    await AutomationProfile.updateOne(
      { userId: user._id },
      { $setOnInsert: { userId: user._id, data: profile, source: 'local-migration', migratedAt: new Date() } },
      { upsert: true }
    );
    await AutomationAccountState.updateOne(
      { userId: user._id },
      { $setOnInsert: { userId: user._id, ...accountState, source: 'local-migration', migratedAt: new Date() } },
      { upsert: true }
    );
    let contactsProcessed = 0;
    for (let offset = 0; offset < contacts.length; offset += CONTACT_BATCH_SIZE) {
      const batch = contacts.slice(offset, offset + CONTACT_BATCH_SIZE);
      await AutomationContact.bulkWrite(batch.map(contact => ({
        updateOne: {
          filter: { userId: user._id, emailNormalized: contact.emailNormalized },
          update: { $setOnInsert: { userId: user._id, ...contact } },
          upsert: true,
        },
      })), { ordered: false });
      contactsProcessed += batch.length;
      console.log(`Contacts migrated: ${contactsProcessed}/${contacts.length}`);
    }
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: FILE_BUCKET });
    let copiedFiles = 0;
    for (const file of files) if (await uploadPrivateFile(bucket, user._id, file)) copiedFiles++;
    for (const file of descriptions) if (await uploadBuffer(bucket, user._id, file)) copiedFiles++;
    let jobsProcessed = 0;
    for (let offset = 0; offset < jobs.length; offset += JOB_BATCH_SIZE) {
      const batch = jobs.slice(offset, offset + JOB_BATCH_SIZE);
      await AutomationJob.bulkWrite(batch.map(job => ({
        updateOne: {
          filter: { userId: user._id, jobId: job.jobId },
          update: { $setOnInsert: { userId: user._id, ...job, migratedAt: new Date() } },
          upsert: true,
        },
      })), { ordered: false });
      jobsProcessed += batch.length;
      console.log(`Jobs migrated: ${jobsProcessed}/${jobs.length}`);
    }
    console.log(`Migration finished. Existing profile/contact/state/job records were preserved; ${contactsProcessed} contacts and ${jobsProcessed} jobs checked in batches; ${copiedFiles} private files were added to GridFS.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`Migration stopped: ${error.message}`);
  mongoose.disconnect().finally(() => { process.exitCode = 1; });
});

module.exports = { assertLocalWorkerIdle, assertOwnerBinding, contactRecords, localPrivateFiles, readJson, splitState };
