require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { getMongoOptions } = require('../src/mongoOptions');
const { assertTestDatabaseUri } = require('./testDatabaseGuard');

async function main() {
  assertTestDatabaseUri(process.env.MONGODB_TEST_URI);
  const tokenFile = path.resolve(process.env.LOAD_TEST_TOKENS_FILE || '');
  if (!process.env.LOAD_TEST_TOKENS_FILE || !fs.existsSync(tokenFile)) throw new Error('Set LOAD_TEST_TOKENS_FILE to the synthetic user token file to clean up.');
  const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (!/^[a-f\d]{12}$/i.test(data.runId || '') || !Array.isArray(data.users) || !data.users.length) throw new Error('Refusing cleanup: invalid synthetic account manifest.');
  for (const user of data.users) {
    if (!/^[a-f\d]{24}$/i.test(user.userId || '') || user.email !== `loadtest-${data.runId}-${String(data.users.indexOf(user) + 1).padStart(3, '0')}@example.test`) {
      throw new Error('Refusing cleanup: account manifest does not match the generated load-test naming scheme.');
    }
  }

  const models = require('../src/models');
  const { User, Job, Resume, Report, Application, AutomationRun, AutomationJob, AutomationAccountState, AutomationProfile, AutomationContact, AutomationCredential, AutomationCampaign, NotificationDelivery } = models;
  const ids = data.users.map(user => new mongoose.Types.ObjectId(user.userId));
  await mongoose.connect(process.env.MONGODB_TEST_URI, getMongoOptions());
  try {
    const existing = await User.find({ _id: { $in: ids } }).select('_id email').lean();
    const byId = new Map(existing.map(user => [String(user._id), user.email]));
    for (const expected of data.users) {
      const email = byId.get(expected.userId);
      if (email && email !== expected.email) throw new Error(`Refusing to delete account ${expected.userId}: its email no longer matches the test manifest.`);
    }
    await Promise.all([
      Job.deleteMany({ userId: { $in: ids } }), Resume.deleteMany({ userId: { $in: ids } }),
      Report.deleteMany({ userId: { $in: ids } }), Application.deleteMany({ userId: { $in: ids } }),
      AutomationRun.deleteMany({ userId: { $in: ids } }), AutomationJob.deleteMany({ userId: { $in: ids } }),
      AutomationAccountState.deleteMany({ userId: { $in: ids } }), AutomationProfile.deleteMany({ userId: { $in: ids } }),
      AutomationContact.deleteMany({ userId: { $in: ids } }), AutomationCredential.deleteMany({ userId: { $in: ids } }),
      AutomationCampaign.deleteMany({ userId: { $in: ids } }), NotificationDelivery.deleteMany({ userId: { $in: ids } }),
      User.deleteMany({ _id: { $in: ids } }),
    ]);
    const filesCollection = mongoose.connection.db.collection('automationFiles.files');
    const fileDocs = await filesCollection.find({ 'metadata.userId': { $in: data.users.map(user => user.userId) } }, { projection: { _id: 1 } }).toArray().catch(error => {
      if (error.codeName === 'NamespaceNotFound') return [];
      throw error;
    });
    if (fileDocs.length) {
      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'automationFiles' });
      for (const file of fileDocs) await bucket.delete(file._id);
    }
    fs.unlinkSync(tokenFile);
    console.log(`Removed ${data.users.length} synthetic accounts, their owned records/files, and the local token manifest.`);
  } finally { await mongoose.disconnect(); }
}

main().catch(error => { console.error('Load-test cleanup failed:', error.message); process.exitCode = 1; });
