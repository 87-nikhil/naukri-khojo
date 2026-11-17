require('dotenv').config();
const mongoose = require('mongoose');
const os = require('node:os');
const crypto = require('node:crypto');
const { runJobHunt, getRunStatus } = require('../src/runner');
const { connectQueueDb, claimNext, heartbeat, heartbeatWorker, ownsRunLease, finish, recoverExpiredRuns, recoverOrphanedRunLocks, recoverUnpinnedBrowserRuns, recoverOfflineBrowserRuns, consumeVerificationCode } = require('../src/automationQueue');

let workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID()}`;
const pollMs = Math.max(500, Number(process.env.AUTOMATION_QUEUE_POLL_MS) || 1500);
let stopping = false;
let activeRun = null;
let workerPromise = null;
let lastRecoveryAt = 0;
let lastWorkerHeartbeatAt = 0;
let runTypes = ['job-hunt'];

async function touchWorker() {
  if (Date.now() - lastWorkerHeartbeatAt < 30_000) return;
  await heartbeatWorker(workerId);
  lastWorkerHeartbeatAt = Date.now();
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function runSnapshot(run) {
  if (run.type === 'browser-automation') {
    const store = require('../src/automation/store');
    return store.runAsUser(String(run.userId), () => {
      const state = store.state();
      const latest = state.runs?.[0];
      return {
        step: latest?.status || 'running',
        progress: latest?.status === 'complete' ? 95 : latest?.status === 'failed' ? 90 : 35,
        logs: (state.events || []).slice(0, 100).map(event => ({ time: event.time, message: event.message })),
        error: latest?.error || null,
      };
    });
  }
  return getRunStatus(run.userId);
}

async function executeRun(run, assertLease, runFence) {
  if (run.type === 'job-hunt') return runJobHunt(run.userId, false, { assertLease });
  if (run.type === 'browser-automation') {
    const store = require('../src/automation/store');
    const automationRunner = require('../src/automation/runner');
    const userData = require('../src/automation/userData');
    const modes = {
      daily: { discovery: true, apply: true },
      discover: { discovery: true, apply: false },
      apply: { discovery: false, apply: true },
      'dry-run': { discovery: false, apply: true, dryRun: true },
      verification: { discovery: false, apply: true },
    };
    if (!modes[run.mode]) throw new Error('Queued browser automation run has an invalid mode.');
    const verificationCode = run.mode === 'verification' ? consumeVerificationCode(run.userId) : undefined;
    if (run.mode === 'verification' && !verificationCode) throw new Error('The one-time verification code expired when the worker restarted. Submit it again.');
    return store.runAsUser(String(run.userId), async () => {
      await userData.loadAutomationState(String(run.userId), { forRun: true, jobId: run.jobId || null, runFence });
      try {
        await assertLease();
        return await automationRunner.run({ ...modes[run.mode], jobId: run.jobId || undefined, verificationCode, assertLease, runFence });
      } finally {
        await userData.saveAutomationState(String(run.userId), store.state(), { runFence });
      }
    });
  }
  throw new Error(`Unsupported automation run type: ${run.type}`);
}

async function execute(run) {
  activeRun = run;
  let leaseLost = false;
  const assertLease = async () => {
    if (leaseLost || !await ownsRunLease(run._id, workerId)) {
      leaseLost = true;
      throw new Error('Automation queue lease was lost; stopping before the next application action.');
    }
  };
  console.log(`Starting ${run.type} run ${run._id} for account ${run.userId}`);
  let pulseInFlight = false;
  const pulse = setInterval(() => {
    if (pulseInFlight || leaseLost) return;
    pulseInFlight = true;
    touchWorker().catch(error => console.error('Could not renew worker heartbeat:', error.message));
    runSnapshot(run).then(status => heartbeat(run._id, workerId, status)).then(result => {
      if (!result.leaseValid) {
        leaseLost = true;
        console.error(`Lease lost for run ${run._id}; the worker will not begin further application actions.`);
      }
    }).catch(error => {
      console.error(`Could not renew lease for run ${run._id}:`, error.message);
    }).finally(() => { pulseInFlight = false; });
  }, Math.max(1000, Math.floor(require('../src/automationQueue').LEASE_MS / 3)));
  pulse.unref();

  try {
    await assertLease();
    const runFence = { runId: run._id, workerId };
    const result = await executeRun(run, assertLease, runFence);
    await assertLease();
    const pulseResult = await heartbeat(run._id, workerId, await runSnapshot(run));
    if (!pulseResult.leaseValid) { leaseLost = true; return; }
    await finish(run, workerId, null, result);
    console.log(`Completed ${run.type} run ${run._id}`);
  } catch (error) {
    if (!leaseLost) {
      const pulseResult = await heartbeat(run._id, workerId, await runSnapshot(run).catch(() => getRunStatus(run.userId))).catch(() => null);
      if (!pulseResult?.leaseValid) leaseLost = true;
    }
    if (!leaseLost) await finish(run, workerId, error).catch(finishError => console.error('Could not persist run failure:', finishError.message));
    console.error(`${run.type} run ${run._id} failed:`, error.message);
  } finally {
    clearInterval(pulse);
    activeRun = null;
  }
}

async function main() {
  while (!stopping) {
    try {
      await connectQueueDb();
      await touchWorker();
      if (Date.now() - lastRecoveryAt > 30_000) {
        if (runTypes.includes('browser-automation')) await recoverUnpinnedBrowserRuns();
        if (runTypes.includes('browser-automation')) await recoverOfflineBrowserRuns();
        await recoverExpiredRuns();
        await recoverOrphanedRunLocks();
        lastRecoveryAt = Date.now();
      }
      const run = await claimNext(workerId, runTypes);
      if (run) await execute(run);
      else await sleep(pollMs);
    } catch (error) {
      console.error('Automation queue worker poll failed:', error.message);
      await sleep(Math.max(pollMs, 5000));
    }
  }

  if (activeRun) console.log(`Waiting for active run ${activeRun._id} to finish before shutdown.`);
}

function start(options = {}) {
  if (workerPromise) return workerPromise;
  if (options.workerId !== undefined) {
    if (typeof options.workerId !== 'string' || !/^[a-z\d_.:-]{1,160}$/i.test(options.workerId)) throw new Error('Invalid automation worker ID.');
    workerId = options.workerId;
  }
  runTypes = options.types || ['job-hunt'];
  stopping = false;
  workerPromise = main().finally(() => { workerPromise = null; });
  return workerPromise;
}

async function stop() {
  stopping = true;
  if (workerPromise) await workerPromise;
}

if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop().finally(() => mongoose.disconnect()); });
  start().catch(async error => {
    console.error('Automation queue worker stopped:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { start, stop };
