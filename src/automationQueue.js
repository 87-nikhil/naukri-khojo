const mongoose = require('mongoose');
const { getMongoOptions } = require('./mongoOptions');
const { User, AutomationRun, AutomationWorkerSlot, AutomationQueueConfig, AutomationWorkerInstance, AutomationJob } = require('./models');

const configuredLeaseMs = Number(process.env.AUTOMATION_RUN_LEASE_MS) || 90_000;
if (!Number.isFinite(configuredLeaseMs) || configuredLeaseMs < 15_000 || configuredLeaseMs > 15 * 60_000) {
  throw new Error('AUTOMATION_RUN_LEASE_MS must be between 15000 and 900000 milliseconds.');
}
const LEASE_MS = configuredLeaseMs;
const WORKER_OFFLINE_MS = LEASE_MS * 3;
const GLOBAL_MAX_RUNS = Math.max(1, Math.min(100, Number.parseInt(process.env.AUTOMATION_GLOBAL_MAX_RUNS, 10) || 1));
let dbConnectPromise = null;
let workerSlotsPromise = null;
const ephemeralVerificationCodes = new Map();

async function connectQueueDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required when the durable automation queue is enabled.');
  if (!dbConnectPromise) {
    dbConnectPromise = mongoose.connect(process.env.MONGODB_URI, getMongoOptions())
      .finally(() => { dbConnectPromise = null; });
  }
  return dbConnectPromise;
}

async function enqueueRun(userId, type, fields = {}, ephemeralCode = null, interactiveLeaseKey = null, idempotencyKey = null) {
  if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[a-z\d:_-]{1,120}$/i.test(idempotencyKey))) {
    throw new Error('Invalid automation run idempotency key.');
  }
  if (idempotencyKey) {
    const existing = await AutomationRun.findOne({ userId, idempotencyKey }).lean();
    if (existing) return { accepted: false, duplicate: true, activeRun: existing };
  }
  const runId = new mongoose.Types.ObjectId();
  const now = new Date();
  const leaseConditions = [
    { automationInteractiveLeaseUntil: null },
    { automationInteractiveLeaseUntil: { $exists: false } },
    { automationInteractiveLeaseUntil: { $lte: now } },
  ];
  if (interactiveLeaseKey) leaseConditions.push({ automationInteractiveLeaseKey: interactiveLeaseKey });
  const owner = await User.findOneAndUpdate(
    { _id: userId, $and: [
      { $or: [{ automationActiveRunId: null }, { automationActiveRunId: { $exists: false } }] },
      { $or: leaseConditions },
    ] },
    { $set: { automationActiveRunId: runId, automationInteractiveLeaseUntil: null, automationInteractiveLeaseKey: null } },
    { new: true, projection: { _id: 1 } }
  );
  if (!owner) {
    const user = await User.findById(userId).select('automationActiveRunId automationInteractiveLeaseUntil').lean();
    const activeRun = user?.automationActiveRunId
      ? await AutomationRun.findOne({ _id: user.automationActiveRunId, userId }).lean()
      : null;
    return {
      accepted: false,
      activeRun,
      interactiveLeaseUntil: user?.automationInteractiveLeaseUntil > now ? user.automationInteractiveLeaseUntil : null,
    };
  }

  if (ephemeralCode) ephemeralVerificationCodes.set(String(userId), ephemeralCode);
  try {
    const run = await AutomationRun.create({ _id: runId, userId, type, ...fields, ...(idempotencyKey ? { idempotencyKey } : {}) });
    return { accepted: true, run };
  } catch (error) {
    if (ephemeralCode) ephemeralVerificationCodes.delete(String(userId));
    const restore = { automationActiveRunId: null };
    if (interactiveLeaseKey) {
      restore.automationInteractiveLeaseKey = interactiveLeaseKey;
      restore.automationInteractiveLeaseUntil = new Date(Date.now() + Math.max(60_000, Number(process.env.AUTOMATION_INTERACTIVE_LEASE_MS) || 30 * 60_000));
    }
    await User.updateOne({ _id: userId, automationActiveRunId: runId }, { $set: restore });
    if (idempotencyKey && error.code === 11000) {
      const existing = await AutomationRun.findOne({ userId, idempotencyKey }).lean();
      if (existing) return { accepted: false, duplicate: true, activeRun: existing };
    }
    throw error;
  }
}

function dailyJobHuntIdempotencyKey(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return `daily-job-hunt:${day}`;
}

async function enqueueJobHunt(userId, { idempotencyKey = null } = {}) {
  return enqueueRun(userId, 'job-hunt', {}, null, null, idempotencyKey);
}

async function enqueueBrowserAutomation(userId, { mode, jobId, verificationCode, interactiveLeaseKey, targetWorkerId } = {}) {
  if (!['daily', 'discover', 'apply', 'dry-run', 'verification'].includes(mode)) throw new Error('Unknown browser automation run mode.');
  if (jobId !== undefined && (typeof jobId !== 'string' || !/^[a-z\d_-]{1,160}$/i.test(jobId))) throw new Error('Invalid automation job ID.');
  if (mode === 'verification' && !/^[A-Za-z0-9]{8}$/.test(verificationCode || '')) throw new Error('Invalid one-time verification code.');
  if (mode !== 'verification' && verificationCode !== undefined) throw new Error('Verification codes are accepted only for verification runs.');
  if (interactiveLeaseKey !== undefined && mode !== 'verification') throw new Error('Interactive browser leases can only be transferred to a verification run.');
  if (interactiveLeaseKey !== undefined && (typeof interactiveLeaseKey !== 'string' || !/^[a-f\d-]{36}$/i.test(interactiveLeaseKey))) throw new Error('Invalid interactive browser lease key.');
  if (typeof targetWorkerId !== 'string' || !/^[a-z\d_.:-]{1,160}$/i.test(targetWorkerId)) throw new Error('A valid automation instance ID is required for browser runs.');
  return enqueueRun(userId, 'browser-automation', { mode, jobId: jobId || null, targetWorkerId }, mode === 'verification' ? verificationCode : null, interactiveLeaseKey || null);
}

function consumeVerificationCode(userId) {
  const key = String(userId), value = ephemeralVerificationCodes.get(key);
  ephemeralVerificationCodes.delete(key);
  return value || null;
}

async function claimNext(workerId, types = ['job-hunt']) {
  if (!Array.isArray(types) || !types.length || types.some(type => !['job-hunt', 'browser-automation'].includes(type))) throw new Error('Invalid automation queue worker types.');
  const slotId = await acquireWorkerSlot(workerId);
  if (!slotId) return null;
  const now = new Date();
  try {
    const run = await AutomationRun.findOneAndUpdate(
      {
        status: 'queued', type: { $in: types },
        $or: [
          { type: 'job-hunt' },
          { type: 'browser-automation', targetWorkerId: workerId },
        ],
      },
      { $set: { status: 'running', step: 'starting', workerId, workerSlotId: slotId, startedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: 1 } }
    );
    if (!run) {
      await releaseWorkerSlot(slotId, workerId);
      return null;
    }
    const attached = await AutomationWorkerSlot.updateOne(
      { _id: slotId, workerId, runId: null, leaseUntil: { $gt: new Date() } },
      { $set: { runId: run._id, leaseUntil: new Date(Date.now() + LEASE_MS) } }
    );
    if (!attached.matchedCount) {
      await AutomationRun.updateOne(
        { _id: run._id, status: 'running', workerId, workerSlotId: slotId },
        { $set: { status: 'queued', step: 'queued', workerId: null, workerSlotId: null, startedAt: null, leaseUntil: null }, $inc: { attempts: -1 } }
      );
      await releaseWorkerSlot(slotId, workerId);
      return null;
    }
    return run;
  } catch (error) {
    await releaseWorkerSlot(slotId, workerId).catch(() => {});
    throw error;
  }
}

async function acquireWorkerSlot(workerId) {
  const now = new Date();
  if (!workerSlotsPromise) {
    workerSlotsPromise = (async () => {
      let config;
      try {
        config = await AutomationQueueConfig.findOneAndUpdate(
          { _id: 'global' },
          { $setOnInsert: { _id: 'global', globalMaxRuns: GLOBAL_MAX_RUNS } },
          { upsert: true, new: true }
        ).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        config = await AutomationQueueConfig.findById('global').lean();
      }
      if (config?.globalMaxRuns !== GLOBAL_MAX_RUNS) {
        throw new Error(`AUTOMATION_GLOBAL_MAX_RUNS=${GLOBAL_MAX_RUNS} does not match the Mongo queue capacity (${config?.globalMaxRuns ?? 'missing'}). Drain workers and update the shared queue configuration before changing this value.`);
      }
      await AutomationWorkerSlot.bulkWrite(Array.from({ length: GLOBAL_MAX_RUNS }, (_, index) => ({
        updateOne: { filter: { _id: `automation-slot-${index}` }, update: { $setOnInsert: { _id: `automation-slot-${index}`, workerId: null, runId: null, leaseUntil: null } }, upsert: true },
      })), { ordered: false });
    })().catch(error => { workerSlotsPromise = null; throw error; });
  }
  await workerSlotsPromise;
  for (let index = 0; index < GLOBAL_MAX_RUNS; index++) {
    const slotId = `automation-slot-${index}`;
    const slot = await AutomationWorkerSlot.findOneAndUpdate(
      { _id: slotId, $or: [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
      { $set: { workerId, runId: null, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { new: true }
    );
    if (slot) return slotId;
  }
  return null;
}

function releaseWorkerSlot(slotId, workerId, runId = null) {
  if (!slotId) return Promise.resolve();
  const filter = { _id: slotId, workerId };
  if (runId) filter.runId = runId;
  return AutomationWorkerSlot.updateOne(filter, { $set: { workerId: null, runId: null, leaseUntil: null } });
}

async function recoverUnpinnedBrowserRuns() {
  const runs = await AutomationRun.find({
    type: 'browser-automation', status: 'queued',
    $or: [{ targetWorkerId: null }, { targetWorkerId: { $exists: false } }],
  }).select('_id userId').lean();
  for (const run of runs) {
    const changed = await AutomationRun.updateOne(
      { _id: run._id, status: 'queued', $or: [{ targetWorkerId: null }, { targetWorkerId: { $exists: false } }] },
      { $set: {
        status: 'interrupted', step: 'interrupted',
        error: 'Browser run had no automation-instance affinity. Review it and requeue from the signed-in automation instance.',
        finishedAt: new Date(),
      } }
    );
    if (changed.modifiedCount) {
      ephemeralVerificationCodes.delete(String(run.userId));
      await User.updateOne(
        { _id: run.userId, automationActiveRunId: run._id },
        { $set: { automationActiveRunId: null } }
      );
    }
  }
}

async function heartbeatWorker(workerId) {
  const now = new Date();
  await AutomationWorkerInstance.updateOne(
    { _id: workerId },
    { $set: { lastSeenAt: now } },
    { upsert: true }
  );
}

async function recoverOfflineBrowserRuns() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WORKER_OFFLINE_MS);
  const queued = await AutomationRun.find({
    type: 'browser-automation', status: 'queued', targetWorkerId: { $type: 'string' }, createdAt: { $lte: cutoff },
  }).select('_id userId targetWorkerId').lean();
  if (!queued.length) return 0;

  const workerIds = [...new Set(queued.map(run => run.targetWorkerId))];
  const workers = await AutomationWorkerInstance.find({ _id: { $in: workerIds }, lastSeenAt: { $gt: cutoff } }).select('_id').lean();
  const online = new Set(workers.map(worker => worker._id));
  let interrupted = 0;
  for (const run of queued) {
    if (online.has(run.targetWorkerId)) continue;
    const changed = await AutomationRun.updateOne(
      { _id: run._id, status: 'queued', type: 'browser-automation', targetWorkerId: run.targetWorkerId, createdAt: { $lte: cutoff } },
      { $set: {
        status: 'interrupted', step: 'interrupted', finishedAt: now,
        error: `Target browser automation instance ${run.targetWorkerId} has not checked in; review and requeue from an available signed-in instance.`,
      } }
    );
    if (changed.modifiedCount) {
      interrupted++;
      ephemeralVerificationCodes.delete(String(run.userId));
      await User.updateOne({ _id: run.userId, automationActiveRunId: run._id }, { $set: { automationActiveRunId: null } });
    }
  }
  return interrupted;
}

async function heartbeat(runId, workerId, status) {
  const now = new Date();
  const logs = (status.logs || []).slice(-100).map(item => ({ time: new Date(item.time), message: item.message }));
  const session = await mongoose.startSession();
  let leaseLost = false;
  try {
    await session.withTransaction(async () => {
      const run = await AutomationRun.findOne({ _id: runId, status: 'running', workerId, leaseUntil: { $gt: now } })
        .select('workerSlotId').session(session).lean();
      if (!run?.workerSlotId) { leaseLost = true; throw Object.assign(new Error('QUEUE_LEASE_LOST'), { code: 'QUEUE_LEASE_LOST' }); }
      const leaseUntil = new Date(now.getTime() + LEASE_MS);
      const runUpdate = await AutomationRun.updateOne(
        { _id: runId, status: 'running', workerId, workerSlotId: run.workerSlotId, leaseUntil: { $gt: now } },
        { $set: {
          leaseUntil,
          step: status.step || 'running',
          progress: Number(status.progress) || 0,
          ...(logs.length ? { logs } : {}),
          ...(status.error ? { error: String(status.error).slice(0, 1000) } : {}),
        } }, { session }
      );
      if (!runUpdate.matchedCount) { leaseLost = true; throw Object.assign(new Error('QUEUE_LEASE_LOST'), { code: 'QUEUE_LEASE_LOST' }); }
      const slotUpdate = await AutomationWorkerSlot.updateOne(
        { _id: run.workerSlotId, workerId, runId, leaseUntil: { $gt: now } },
        { $set: { leaseUntil } }, { session }
      );
      if (!slotUpdate.matchedCount) { leaseLost = true; throw Object.assign(new Error('QUEUE_LEASE_LOST'), { code: 'QUEUE_LEASE_LOST' }); }
    });
    return { matchedCount: 1, leaseValid: true };
  } catch (error) {
    if (leaseLost || error.code === 'QUEUE_LEASE_LOST') return { matchedCount: 0, leaseValid: false };
    throw error;
  } finally { await session.endSession(); }
}

async function ownsRunLease(runId, workerId) {
  const now = new Date();
  const run = await AutomationRun.findOne({ _id: runId, status: 'running', workerId, leaseUntil: { $gt: now } })
    .select('workerSlotId').lean();
  if (!run?.workerSlotId) return false;
  return !!(await AutomationWorkerSlot.exists({ _id: run.workerSlotId, workerId, runId, leaseUntil: { $gt: now } }));
}

async function finish(run, workerId, error, result) {
  const status = error ? 'failed' : 'complete';
  const updated = await AutomationRun.findOneAndUpdate(
    { _id: run._id, status: 'running', workerId, workerSlotId: run.workerSlotId, leaseUntil: { $gt: new Date() } },
    { $set: {
      status,
      step: status,
      progress: error ? run.progress : 100,
      error: error ? String(error.message || error).slice(0, 1000) : null,
      result: result || null,
      finishedAt: new Date(),
      leaseUntil: null,
      workerSlotId: null,
    } },
    { new: true }
  );
  if (updated) {
    await User.updateOne({ _id: run.userId, automationActiveRunId: run._id }, { $set: { automationActiveRunId: null } });
    await releaseWorkerSlot(run.workerSlotId, workerId, run._id);
  }
  return updated;
}

// A crashed worker may have sent notifications before dying. Mark the run for
// review instead of automatically replaying it and risking duplicate effects.
async function recoverExpiredRuns() {
  const expired = await AutomationRun.find({ status: 'running', leaseUntil: { $lte: new Date() } }).select('_id userId workerId workerSlotId type').lean();
  for (const run of expired) {
    const changed = await AutomationRun.updateOne(
      { _id: run._id, status: 'running', leaseUntil: { $lte: new Date() } },
      { $set: { status: 'interrupted', step: 'interrupted', error: 'Worker lease expired; review before retrying.', finishedAt: new Date(), leaseUntil: null, workerSlotId: null } }
    );
    if (changed.modifiedCount) {
      if (run.type === 'browser-automation') await AutomationJob.updateMany(
        { userId: run.userId, 'data.status': { $in: ['filling', 'submitting'] } },
        { $set: {
          'data.status': 'submission_uncertain',
          'data.reason': 'Worker lease expired during an application attempt. Verify before retrying.',
        } }
      );
      await User.updateOne({ _id: run.userId, automationActiveRunId: run._id }, { $set: { automationActiveRunId: null } });
      await releaseWorkerSlot(run.workerSlotId, run.workerId, run._id);
    }
  }
}

async function recoverOrphanedRunLocks() {
  const lockedUsers = await User.find({ automationActiveRunId: { $ne: null } }).select('_id automationActiveRunId').lean();
  for (const user of lockedUsers) {
    const activeRun = await AutomationRun.findOne({
      _id: user.automationActiveRunId,
      userId: user._id,
    }).select('status').lean();
    const oldEnoughToBeOrphaned = user.automationActiveRunId.getTimestamp().getTime() < Date.now() - 5 * 60_000;
    if ((activeRun && !['queued', 'running'].includes(activeRun.status)) || (!activeRun && oldEnoughToBeOrphaned)) {
      await User.updateOne({ _id: user._id, automationActiveRunId: user.automationActiveRunId }, { $set: { automationActiveRunId: null } });
    }
  }
}

module.exports = { LEASE_MS, GLOBAL_MAX_RUNS, connectQueueDb, enqueueJobHunt, dailyJobHuntIdempotencyKey, enqueueBrowserAutomation, consumeVerificationCode, claimNext, heartbeat, heartbeatWorker, ownsRunLease, finish, recoverExpiredRuns, recoverOrphanedRunLocks, recoverUnpinnedBrowserRuns, recoverOfflineBrowserRuns };
