// MongoDB is the durable source for profiles/contacts and, in queued mode,
// account automation state. Scoped JSON remains the local worker cache.
const store = require('./store');
const crypto = require('node:crypto');
const { connectQueueDb } = require('../automationQueue');
const mongoose = require('mongoose');
const { User, AutomationProfile, AutomationContact, AutomationCredential, AutomationJob, AutomationAccountState, AutomationRun, AutomationWorkerSlot } = require('../models');
const secrets = require('./secrets');
const JOB_DESCRIPTION_BUCKET = 'automationFiles';
const stateRevisions = new Map();
const profileRevisions = new Map();
const contactMutationTails = new Map();
const CONTACT_MUTATION_LEASE_MS = 120_000;
const DEFAULT_AUTOMATION_SETTINGS = { autoApply: true, dailyTarget: 15, paused: false, headless: true, quietHours: { start: 21, end: 3 }, skipAts: ['linkedin'] };

function mongoEnabled() { return !!process.env.MONGODB_URI; }

async function ready(userId) {
  if (!mongoEnabled()) return false;
  if (!userId) throw new Error('An authenticated account is required for MongoDB automation data.');
  await connectQueueDb();
  return true;
}

async function loadProfile(userId, fallback = store.read('profile', null)) {
  assertUserScope(userId);
  if (!await ready(userId)) return fallback;
  const record = await AutomationProfile.findOne({ userId }).lean();
  profileRevisions.set(String(userId), Number(record?.revision) || 0);
  if (record?.data && typeof record.data === 'object') store.write('profile', record.data);
  return record?.data || fallback;
}

async function saveProfile(userId, profile) {
  assertUserScope(userId);
  if (await ready(userId)) {
    const expectedRevision = profileRevisions.get(String(userId)) || 0;
    try {
      const result = await AutomationProfile.updateOne(
        { userId, $or: [{ revision: expectedRevision }, { revision: { $exists: false } }] },
        { $set: { data: profile, source: 'portal' }, $inc: { revision: 1 }, $setOnInsert: { userId } },
        { upsert: true }
      );
      if (!result.matchedCount && !result.upsertedCount) {
        const error = new Error('The candidate profile changed in another request. Reload it and retry your change.');
        error.statusCode = 409;
        throw error;
      }
      profileRevisions.set(String(userId), expectedRevision + 1);
    } catch (error) {
      // A stale upsert can hit the unique userId index when another request
      // has already advanced the profile revision.
      if (error.code === 11000) {
        const conflict = new Error('The candidate profile changed in another request. Reload it and retry your change.');
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }
  store.write('profile', profile);
  return profile;
}

function cleanContact(contact) {
  return {
    id: String(contact.id || contact.contactId || contact._id || ''),
    email: String(contact.email || '').trim(),
    emailNormalized: String(contact.emailNormalized || contact.email || '').trim().toLowerCase(),
    name: String(contact.name || ''),
    companies: Array.isArray(contact.companies) ? contact.companies : [],
    sourceFiles: Array.isArray(contact.sourceFiles) ? contact.sourceFiles : [],
    firstImportedAt: contact.firstImportedAt,
    lastImportedAt: contact.lastImportedAt,
    importCount: Number(contact.importCount) || 0,
    status: contact.status === 'archived' ? 'archived' : 'active',
    updatedAt: contact.updatedAt,
  };
}

async function loadContacts(userId) {
  assertUserScope(userId);
  if (!await ready(userId)) return store.read('company-contacts', []);
  let records = await AutomationContact.find({ userId }).lean();
  if (records.length) {
    const contacts = records.map(cleanContact).filter(contact => contact.id && contact.emailNormalized);
    store.write('company-contacts', contacts);
    return contacts;
  }
  // Preserve and seed the user's existing local address book on its first DB-backed session.
  const localContacts = store.read('company-contacts', []);
  if (Array.isArray(localContacts) && localContacts.length) {
    const byEmail = new Map(localContacts.map(raw => {
      const contact = cleanContact(raw);
      return [contact.emailNormalized, contact];
    }).filter(([email, contact]) => email && contact.id));
    const operations = [...byEmail.values()].map(contact => ({
      updateOne: {
        filter: { userId, emailNormalized: contact.emailNormalized },
        update: { $setOnInsert: { ...contact, contactId: contact.id, userId } },
        upsert: true,
      },
    }));
    try { if (operations.length) await AutomationContact.bulkWrite(operations, { ordered: false }); }
    catch (error) { if (error.code !== 11000 && !error.writeErrors?.every(item => item.code === 11000)) throw error; }
    records = await AutomationContact.find({ userId }).lean();
    const contacts = records.map(cleanContact).filter(contact => contact.id && contact.emailNormalized);
    store.write('company-contacts', contacts);
    return contacts;
  }
  store.write('company-contacts', []);
  return store.read('company-contacts', []);
}

async function saveContacts(userId, contacts, { leaseToken = null } = {}) {
  assertUserScope(userId);
  if (!Array.isArray(contacts)) throw new Error('Saved contacts data is invalid.');
  const normalized = contacts.map(raw => {
    const contact = cleanContact(raw);
    if (!contact.id || !contact.emailNormalized) throw new Error('A saved contact is missing its ID or email.');
    return contact;
  });
  if (await ready(userId)) {
    if (!leaseToken) throw new Error('A contact mutation lease is required to save MongoDB contacts.');
    const operations = normalized.map(contact => ({
      updateOne: {
        filter: { userId, emailNormalized: contact.emailNormalized },
        update: { $set: { ...contact, contactId: contact.id, userId } },
        upsert: true,
      },
    }));
    const keepEmails = normalized.map(contact => contact.emailNormalized);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const lease = await User.updateOne({
          _id: userId,
          automationContactMutationLeaseToken: leaseToken,
          automationContactMutationLeaseUntil: { $gt: new Date() },
        }, { $inc: { automationContactMutationFence: 1 } }, { session });
        if (!lease.matchedCount) {
          const error = new Error('The contact update lease expired or was replaced. Reload contacts and retry.');
          error.statusCode = 409;
          throw error;
        }
        if (operations.length) await AutomationContact.bulkWrite(operations, { ordered: true, session });
        await AutomationContact.deleteMany({ userId, ...(keepEmails.length ? { emailNormalized: { $nin: keepEmails } } : {}) }, { session });
      });
    } finally { await session.endSession(); }
  }
  store.write('company-contacts', contacts);
  return contacts;
}

async function withContactMutationLock(userId, callback) {
  assertUserScope(userId);
  if (!userId) throw new Error('An authenticated account is required to update contacts.');
  const key = String(userId);
  const previous = contactMutationTails.get(key) || Promise.resolve();
  let releaseLocal;
  const localTurn = new Promise(resolve => { releaseLocal = resolve; });
  const tail = previous.then(() => localTurn);
  contactMutationTails.set(key, tail);
  await previous;

  let leaseToken = null;
  let heartbeat = null;
  try {
    if (mongoEnabled()) {
      await ready(userId);
      leaseToken = crypto.randomUUID();
      const deadline = Date.now() + 20_000;
      let acquired = false;
      while (!acquired && Date.now() < deadline) {
        const now = new Date();
        const owner = await User.findOneAndUpdate({
          _id: userId,
          $or: [
            { automationContactMutationLeaseUntil: null },
            { automationContactMutationLeaseUntil: { $exists: false } },
            { automationContactMutationLeaseUntil: { $lte: now } },
          ],
        }, {
          $set: {
            automationContactMutationLeaseToken: leaseToken,
            automationContactMutationLeaseUntil: new Date(Date.now() + CONTACT_MUTATION_LEASE_MS),
          },
        }, { new: true, projection: { _id: 1 } });
        acquired = !!owner;
        if (!acquired) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!acquired) {
        const error = new Error('Another contact update is in progress for this account. Retry shortly.');
        error.statusCode = 409;
        throw error;
      }
      heartbeat = setInterval(() => {
        User.updateOne({ _id: userId, automationContactMutationLeaseToken: leaseToken }, {
          $set: { automationContactMutationLeaseUntil: new Date(Date.now() + CONTACT_MUTATION_LEASE_MS) },
        }).catch(error => console.error('Could not renew contact mutation lease:', error.message));
      }, Math.floor(CONTACT_MUTATION_LEASE_MS / 3));
      heartbeat.unref?.();
    }
    return await callback(leaseToken);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (leaseToken) {
      await User.updateOne({ _id: userId, automationContactMutationLeaseToken: leaseToken }, {
        $set: { automationContactMutationLeaseUntil: null, automationContactMutationLeaseToken: null },
      }).catch(error => console.error('Could not release contact mutation lease:', error.message));
    }
    releaseLocal();
    if (contactMutationTails.get(key) === tail) contactMutationTails.delete(key);
  }
}

async function loadCredentials(userId) {
  assertUserScope(userId);
  if (!await ready(userId)) return secrets.readLocal();
  const record = await AutomationCredential.findOne({ userId }).lean();
  if (record) {
    const credentials = secrets.decrypt(record.encryptedSecret);
    secrets.writeLocal(credentials);
    return credentials;
  }
  const local = secrets.readLocal();
  if (local && secrets.isConfigured()) await saveCredentials(userId, local);
  return local;
}

async function saveCredentials(userId, credentials) {
  assertUserScope(userId);
  if (!credentials?.email || !credentials?.appPassword) throw new Error('Valid Gmail credentials are required.');
  if (await ready(userId)) {
    const encryptedSecret = secrets.encrypt(credentials);
    await AutomationCredential.updateOne(
      { userId },
      { $set: { userId, email: String(credentials.email).toLowerCase(), encryptedSecret, verifiedAt: credentials.verifiedAt || null } },
      { upsert: true }
    );
  }
  secrets.writeLocal(credentials);
  return credentials;
}

function assertUserScope(userId) {
  if (String(store.currentUserId() || '') !== String(userId || '')) throw new Error('Automation data access is outside the authenticated account scope.');
}

function localAccountState(snapshot) {
  const { jobs = [], ...account } = snapshot || {};
  const known = new Set(['settings', 'answers', 'excludedCompanies', 'runs', 'events']);
  return {
    settings: account.settings || {},
    answers: account.answers || {},
    excludedCompanies: Array.isArray(account.excludedCompanies) ? account.excludedCompanies : [],
    runs: Array.isArray(account.runs) ? account.runs : [],
    events: Array.isArray(account.events) ? account.events : [],
    extra: Object.fromEntries(Object.entries(account).filter(([key]) => !known.has(key))),
  };
}

async function readJobDescription(userId, logicalName) {
  assertUserScope(userId);
  if (!logicalName || !await ready(userId)) return '';
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: JOB_DESCRIPTION_BUCKET });
  const [file] = await bucket.find({
    'metadata.userId': String(userId), 'metadata.kind': 'job-description', 'metadata.logicalName': logicalName,
  }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!file) return '';
  const chunks = [];
  for await (const chunk of bucket.openDownloadStream(file._id)) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function writeJobDescription(bucket, userId, jobId, description) {
  const logicalName = `job-${require('node:crypto').createHash('sha256').update(String(jobId)).digest('hex').slice(0, 32)}.txt`;
  const buffer = Buffer.from(description, 'utf8');
  const digest = require('node:crypto').createHash('sha256').update(buffer).digest('hex');
  const previous = await bucket.find({
    'metadata.userId': String(userId), 'metadata.kind': 'job-description', 'metadata.logicalName': logicalName,
  }).toArray();
  if (previous.some(file => file.metadata?.sha256 === digest)) return logicalName;
  const upload = bucket.openUploadStream(logicalName, { metadata: {
    userId: String(userId), kind: 'job-description', logicalName, contentType: 'text/plain; charset=utf-8',
    byteLength: buffer.length, sha256: digest,
  } });
  await new Promise((resolve, reject) => {
    upload.once('error', reject);
    upload.once('finish', resolve);
    upload.end(buffer);
  });
  await Promise.all(previous.map(file => bucket.delete(file._id).catch(() => {})));
  return logicalName;
}

async function loadAutomationState(userId, { forRun = false, jobId = null, writeCache = true, runFence = null } = {}) {
  assertUserScope(userId);
  if (!await ready(userId)) return store.state();
  const [account, records] = await Promise.all([
    AutomationAccountState.findOne({ userId }).lean(),
    AutomationJob.find({ userId }).lean(),
  ]);
  if (!account && !records.length) {
    const local = store.state();
    await saveAutomationState(userId, local, { expectedRevision: 0, allowCreate: true, runFence });
    return store.state();
  }
  const extra = account?.extra && typeof account.extra === 'object' ? account.extra : {};
  const jobs = records.map(record => ({ ...record.data, id: String(record.data?.id || record.jobId), descriptionFile: record.descriptionFile || null }));
  const result = {
    ...extra,
    settings: { ...DEFAULT_AUTOMATION_SETTINGS, ...(account?.settings || {}) },
    answers: account?.answers || {},
    excludedCompanies: account?.excludedCompanies || [],
    runs: account?.runs || [],
    events: account?.events || [],
    jobs,
  };
  stateRevisions.set(String(userId), Number(account?.revision) || 0);
  if (writeCache) store.write('state', result);
  if (forRun) {
    const active = jobs.filter(job => (jobId ? job.id === jobId : ['queued', 'ready', 'needs_input', 'submission_uncertain'].includes(job.status)) && job.descriptionFile);
    for (const job of active) job.description = await readJobDescription(userId, job.descriptionFile);
    if (writeCache) store.write('state', result);
  }
  return result;
}

async function assertRunFenceInSession(userId, runFence, session) {
  if (!runFence) return;
  const now = new Date();
  const run = await AutomationRun.findOne({
    _id: runFence.runId, userId, status: 'running', workerId: runFence.workerId, leaseUntil: { $gt: now },
  }).select('workerSlotId').session(session).lean();
  if (!run?.workerSlotId || !await AutomationWorkerSlot.exists({
    _id: run.workerSlotId, workerId: runFence.workerId, runId: runFence.runId, leaseUntil: { $gt: now },
  }).session(session)) throw new Error('Automation queue lease was lost; refusing to persist stale worker state.');
  const owner = await User.updateOne(
    { _id: userId, automationActiveRunId: runFence.runId },
    { $inc: { automationStateFence: 1 } },
    { session }
  );
  if (!owner.matchedCount) throw new Error('Automation account lock was lost; refusing to persist stale worker state.');
}

async function saveAutomationState(userId, snapshot = store.state(), { expectedRevision, allowCreate = false, runFence = null } = {}) {
  assertUserScope(userId);
  if (!await ready(userId)) return snapshot;
  const revision = expectedRevision === undefined ? (stateRevisions.get(String(userId)) || 0) : expectedRevision;
  const account = localAccountState(snapshot);
  const accountBytes = Buffer.byteLength(JSON.stringify(account), 'utf8');
  if (accountBytes > 8 * 1024 * 1024) throw new Error('Automation settings and history exceed the MongoDB document limit.');

  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: JOB_DESCRIPTION_BUCKET });
  const jobOperations = [];
  const jobIds = new Set();
  for (const original of snapshot.jobs || []) {
    const id = String(original.id || original.jobId || '').trim();
    if (!/^[a-z\d_.:-]{1,160}$/i.test(id)) throw new Error('Automation state contains an invalid job ID.');
    if (jobIds.has(id)) continue;
    jobIds.add(id);
    const data = { ...original };
    delete data.descriptionFile;
    const description = typeof data.description === 'string' ? data.description : '';
    delete data.description;
    const descriptionFile = description
      ? await writeJobDescription(bucket, userId, id, description)
      : original.descriptionTrimmed ? null : original.descriptionFile || null;
    jobOperations.push({ updateOne: {
      filter: { userId, jobId: id },
      update: { $set: { data, descriptionFile }, $setOnInsert: { userId, jobId: id } },
      upsert: true,
    } });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await assertRunFenceInSession(userId, runFence, session);
      const revisionFilter = { userId, $or: [{ revision }, { revision: { $exists: false } }] };
      const updated = await AutomationAccountState.updateOne(revisionFilter, {
        $set: { ...account, source: 'portal' }, $inc: { revision: 1 }, $setOnInsert: { userId },
      }, { session });
      if (!updated.matchedCount && allowCreate && !(await AutomationAccountState.exists({ userId }).session(session))) {
        await AutomationAccountState.create([{ userId, ...account, revision: 1, source: 'portal' }], { session });
      } else if (!updated.matchedCount) {
        throw new Error('Automation data changed in another request. Reload the page and retry your change.');
      }
      if (jobOperations.length) await AutomationJob.bulkWrite(jobOperations, { ordered: true, session });
      await AutomationJob.deleteMany({ userId, jobId: { $nin: [...jobIds] } }, { session });
    });
  } catch (error) {
    if (/Transaction numbers are only allowed|does not support transactions|replica set/i.test(error.message)) {
      throw new Error('Queue-mode automation state requires MongoDB transactions (a replica set or MongoDB Atlas).');
    }
    throw error;
  } finally { await session.endSession(); }
  stateRevisions.set(String(userId), revision + 1);
  return snapshot;
}

async function saveAutomationJob(userId, jobId, { runFence = null } = {}) {
  assertUserScope(userId);
  if (!await ready(userId)) return false;
  const job = store.state().jobs.find(item => String(item.id) === String(jobId));
  if (!job) throw new Error('Automation job disappeared before its state could be persisted.');
  const data = { ...job };
  delete data.descriptionFile;
  const description = typeof data.description === 'string' ? data.description : '';
  delete data.description;
  const descriptionFile = description
    ? await writeJobDescription(new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: JOB_DESCRIPTION_BUCKET }), userId, job.id, description)
    : job.descriptionTrimmed ? null : job.descriptionFile || null;
  if (runFence) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await assertRunFenceInSession(userId, runFence, session);
        await AutomationJob.updateOne(
          { userId, jobId: String(job.id) },
          { $set: { userId, jobId: String(job.id), data, descriptionFile } },
          { upsert: true, session }
        );
      });
    } finally { await session.endSession(); }
  } else {
    await AutomationJob.updateOne(
      { userId, jobId: String(job.id) },
      { $set: { userId, jobId: String(job.id), data, descriptionFile } },
      { upsert: true }
    );
  }
  return true;
}

module.exports = { mongoEnabled, loadProfile, saveProfile, loadContacts, saveContacts, withContactMutationLock, loadCredentials, saveCredentials, loadAutomationState, saveAutomationState, saveAutomationJob, readJobDescription };
