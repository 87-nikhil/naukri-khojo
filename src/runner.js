require('dotenv').config();
const mongoose = require('mongoose');
const { getMongoOptions } = require('./mongoOptions');
const { parseResume } = require('./parsers/resumeParser');
const { scrapeAllJobs } = require('./scrapers/jobScraper');
const { matchJobs, categorizeJobs } = require('./matchers/jobMatcher');
const { sendDailyReport, sendInstantJobAlert } = require('./notifiers/notifier');
const { Job, Resume, Report, User } = require('./models');
const path = require('path');

const MIN_SCORE     = parseInt(process.env.MIN_MATCH_SCORE) || 70;
const APPLY_LIMIT   = parseInt(process.env.DAILY_APPLY_LIMIT) || 10;
const RESUME_PATH   = process.env.RESUME_PATH || './resume.pdf';

// ── Run Status Tracking ───────────────────────────────────────────────────────
const runStatuses = new Map();
const MAX_PARALLEL_JOB_HUNTS = Math.max(1, Math.min(100, Number.parseInt(process.env.JOB_HUNT_MAX_PARALLEL_RUNS, 10) || 4));
const MAX_RETAINED_RUN_STATUSES = 2000;
function statusKey(userId) { return String(userId || 'local'); }
function newRunStatus() {
  return { running: false, step: '', progress: 0, totalSteps: 7, logs: [], lastRun: null, error: null };
}
function mutableRunStatus(userId) {
  const key = statusKey(userId);
  if (!runStatuses.has(key) && runStatuses.size >= MAX_RETAINED_RUN_STATUSES) {
    for (const [oldKey, status] of runStatuses) {
      if (!status.running) runStatuses.delete(oldKey);
      if (runStatuses.size < MAX_RETAINED_RUN_STATUSES * 0.75) break;
    }
  }
  if (!runStatuses.has(key)) runStatuses.set(key, newRunStatus());
  return runStatuses.get(key);
}
function updateStatus(userId, step, progress, message) {
  const runStatus = mutableRunStatus(userId);
  runStatus.step = step;
  runStatus.progress = progress;
  if (message) {
    runStatus.logs.push({ time: new Date().toISOString(), message });
  }
}

function getRunStatus(userId) {
  const runStatus = runStatuses.get(statusKey(userId)) || newRunStatus();
  return { ...runStatus, logs: [...runStatus.logs] };
}

function hasRunCapacity(userId) {
  const own = runStatuses.get(statusKey(userId));
  if (own?.running) return false;
  let active = 0;
  for (const status of runStatuses.values()) if (status.running) active++;
  return active < MAX_PARALLEL_JOB_HUNTS;
}

// ── Connect MongoDB ───────────────────────────────────────────────────────────
async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    console.log('✅ MongoDB already connected');
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/naukri-khojo', getMongoOptions());
  console.log('✅ MongoDB connected');
}

// ── Save Jobs to DB ───────────────────────────────────────────────────────────
async function saveJobs(jobs, userId, assertLease) {
  let saved = 0;
  for (const job of jobs) {
    if (assertLease) await assertLease();
    try {
      await Job.findOneAndUpdate(
        { jobId: job.jobId, userId },
        { ...job, userId, foundAt: job.foundAt || new Date() },
        { upsert: true, new: true }
      );
      saved++;
    } catch (err) {
      // Duplicate — skip
    }
  }
  return saved;
}

// ── Mark Jobs as Applied ──────────────────────────────────────────────────────
async function markApplied(jobs, userId) {
  for (const job of jobs) {
    await Job.findOneAndUpdate(
      { jobId: job.jobId, ...(userId ? { userId } : {}) },
      { status: 'applied', appliedAt: new Date() }
    );
  }
}

// ── Main Hunt Runner ──────────────────────────────────────────────────────────
async function runJobHunt(userId, isAdmin = false, { assertLease } = {}) {
  if (!hasRunCapacity(userId)) throw new Error('A job hunt is already active for this account or the server has reached its direct-run capacity.');
  const runStatus = mutableRunStatus(userId);
  runStatus.running = true;
  runStatus.error = null;
  runStatus.logs = [];
  updateStatus(userId, 'starting', 0, 'Job hunt started');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     🔥 Naukri Khojo — Daily Run      ║');
  console.log(`║     ${new Date().toLocaleDateString('en-IN')} ${new Date().toLocaleTimeString('en-IN')}       ║`);
  console.log('╚══════════════════════════════════════╝\n');

  try {
    // ── Step 1: Parse Resume ───────────────────────────────────────────────
    updateStatus(userId, 'parsing_resume', 1, 'Parsing resume...');
    console.log('\n📄 STEP 1: Parsing Resume...');
    let resumeProfile;
    if (userId) {
      // A shared RESUME_PATH must never override the authenticated account's
      // MongoDB profile: doing so can score jobs against another user's resume.
      resumeProfile = await Resume.findOne({ userId }).lean();
      if (!resumeProfile) throw new Error('No resume found. Please upload a resume first.');
    } else {
      resumeProfile = await parseResume(path.resolve(RESUME_PATH));
    }

    // ── Step 3: Scrape Jobs ────────────────────────────────────────────────
    updateStatus(userId, 'scraping_jobs', 2, 'Scraping jobs from all sources...');
    console.log('\n🔍 STEP 2: Scraping Jobs...');
    const rawJobs = await scrapeAllJobs(resumeProfile);
    if (assertLease) await assertLease();

    // ── Step 2b: Enrich Jobs ──────────────────────────────────────────────
    updateStatus(userId, 'enriching_jobs', 2, `Found ${rawJobs.length} jobs. Enriching with descriptions...`);
    console.log('\n🔎 STEP 2b: Enriching Jobs...');
    const { enrichJobs } = require('./scrapers/jobEnricher');
    // Only enrich jobs that have no description
    const toEnrich = rawJobs.filter(j => !j.description && j.source === 'LinkedIn').slice(0, 30);
    const notEnrich = rawJobs.filter(j => j.description || j.source !== 'LinkedIn');
    const enrichedBatch = await enrichJobs(toEnrich, 3);
    const enrichedJobs = [...notEnrich, ...enrichedBatch];
    if (assertLease) await assertLease();

    const savedCount = await saveJobs(enrichedJobs, userId, assertLease);
    console.log(`   💾 Saved ${savedCount} new jobs to database`);
    updateStatus(userId, 'matching_jobs', 3, `Scraped ${enrichedJobs.length} jobs, saved ${savedCount} new. Matching to resume...`);

    // ── Step 4: Match & Score Jobs ─────────────────────────────────────────
    console.log('\n🎯 STEP 3: Matching Jobs to Resume...');
    // Use user's preference for min score (from DB), fallback to env, fallback to 65
    const user = userId ? await User.findById(userId) : null;
    const scoredJobs = matchJobs(enrichedJobs, resumeProfile, user?.companyPreferences);
    const userMinScore = user?.notifications?.minScoreAlert || MIN_SCORE || 65;

    const highMatch = scoredJobs.filter(j => j.matchScore >= userMinScore);
    const readyToApply = highMatch.filter(j => j.directApply);
    console.log(`   ✅ High match (${userMinScore}%+): ${highMatch.length} jobs`);
    console.log(`   🚀 Ready to apply (direct): ${readyToApply.length} jobs`);

    // Update scores in DB
    for (const job of scoredJobs) {
      if (assertLease) await assertLease();
      await Job.findOneAndUpdate({ jobId: job.jobId, userId }, { matchScore: job.matchScore });
    }

    // ── Step 5: Build Report ─────────────────────────────────────────────
    if (assertLease) await assertLease();
    updateStatus(userId, 'building_report', 5, 'Building daily report...');
    console.log('\n📊 STEP 5: Building Report...');
    const report = await Report.create({
      userId:      userId,
      date:        new Date(),
      jobsFound:   enrichedJobs.length,
      highMatch:   highMatch.length,
      applied:     0,
      manualApply: readyToApply.length,
      topJobs:     highMatch.slice(0, 10).map(j => ({
        title:   j.title,
        company: j.company,
        score:   j.matchScore,
        link:    j.applyLink,
      })),
    });

    // ── Step 6: Send Notifications ───────────────────────────────────────
    updateStatus(userId, 'sending_notifications', 6, 'Sending notifications...');
    console.log('\n📬 STEP 6: Sending Notifications...');

    // Send daily report
    if (assertLease) await assertLease();
    await sendDailyReport(report);

    // Send instant Telegram alerts for jobs >= user's minScoreAlert preference
    if (user) {
      const alertJobs = highMatch.slice(0, 5); // top 5 matching jobs
      for (const job of alertJobs) {
        if (assertLease) await assertLease();
        await sendInstantJobAlert(user, job);
      }
      if (alertJobs.length > 0) {
        console.log(`   🔔 Sent ${alertJobs.length} instant alerts to ${user.email}`);
      }
    }

    // ── Final Summary ──────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║            ✅ Run Complete!            ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`\n📊 Summary:`);
    console.log(`   Jobs Found:      ${enrichedJobs.length}`);
    console.log(`   High Match:      ${highMatch.length}`);
    console.log(`   Ready to Apply:  ${readyToApply.length}`);
    console.log('\n🏆 Top 5 Jobs Today:');
    highMatch.slice(0, 5).forEach((j, i) => {
      console.log(`   ${i + 1}. ${j.title} — ${j.company} (${j.matchScore}%) ${j.directApply ? '🟢 Direct' : ''}`);
      console.log(`      👉 ${j.applyLink}`);
    });

    updateStatus(userId, 'complete', 7, `Hunt complete! ${enrichedJobs.length} jobs found, ${highMatch.length} high matches, ${readyToApply.length} ready to apply.`);
    runStatus.running = false;
    runStatus.lastRun = new Date().toISOString();

    return report;

  } catch (err) {
    console.error('❌ Runner error:', err);
    runStatus.running = false;
    runStatus.error = err.message;
    updateStatus(userId, 'error', 0, `Error: ${err.message}`);
    throw err;
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      await runJobHunt();
    } catch (err) {
      // error already logged
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  })();
}

// ── Rescore All Jobs ─────────────────────────────────────────────────────────
async function rescoreAllJobs(userId) {
  await connectDB();

  if (!userId) return 0;
  // Load resume from DB — strictly per user
  const resumeProfile = await Resume.findOne({ userId }).lean();
  if (!resumeProfile) return 0;
  const user = await User.findById(userId).select('companyPreferences').lean();

  // Load all jobs from DB
  const allJobs = userId ? await Job.find({ userId }).lean() : await Job.find().lean();
  if (allJobs.length === 0) return 0;

  // Re-run matching/scoring
  const scoredJobs = matchJobs(allJobs, resumeProfile, user?.companyPreferences);

  // Update each job's matchScore in DB
  let updated = 0;
  for (const job of scoredJobs) {
    await Job.findOneAndUpdate(
      { jobId: job.jobId, ...(userId ? { userId } : {}) },
      { matchScore: job.matchScore }
    );
    updated++;
  }

  console.log(`Rescored ${updated} jobs`);
  return updated;
}

module.exports = { runJobHunt, getRunStatus, hasRunCapacity, rescoreAllJobs };
