// ── Vercel Cron Endpoint ─────────────────────────────────────────────────────
// Runs daily at 8:00 AM IST (2:30 AM UTC) via vercel.json crons config
// Triggers job hunt for ALL users and sends notifications

const mongoose = require('mongoose');
const { getMongoOptions } = require('../src/mongoOptions');
require('dotenv').config();

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/naukri-khojo';
  await mongoose.connect(uri, getMongoOptions());
}

module.exports = async (req, res) => {
  // Verify cron secret (Vercel sends this header for cron jobs)
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await connectDB();

    const { User, Resume, Job, Report } = require('../src/models');

    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
      const { enqueueJobHunt, dailyJobHuntIdempotencyKey } = require('../src/automationQueue');
      const idempotencyKey = dailyJobHuntIdempotencyKey();
      const users = await User.find().select('_id');
      const results = [];
      for (const user of users) {
        try {
          if (!(await Resume.exists({ userId: user._id }))) {
            results.push({ userId: String(user._id), status: 'skipped', reason: 'no resume' });
            continue;
          }
          const queued = await enqueueJobHunt(user._id, { idempotencyKey });
          results.push({ userId: String(user._id), status: queued.accepted ? 'queued' : queued.duplicate ? `already-scheduled:${queued.activeRun?.status || 'unknown'}` : 'already-active' });
        } catch (error) {
          results.push({ userId: String(user._id), status: 'error', error: error.message });
        }
      }
      try {
        const { sendApplicationReminders } = require('../src/notifiers/notifier');
        await sendApplicationReminders();
      } catch (error) {
        console.error('Reminder error:', error.message);
      }
      return res.json({ success: true, queued: results, timestamp: new Date().toISOString() });
    }

    const { fetchRemotive, fetchArbeitnow, fetchHimalayas, fetchJobicy, fetchRemoteOK, fetchTheMuse, scrapeLinkedIn, scrapeNaukri } = require('../src/scrapers/jobScraper');
    const { matchJobs } = require('../src/matchers/jobMatcher');
    const { sendDailyReport, sendInstantJobAlert, sendApplicationReminders } = require('../src/notifiers/notifier');

    const users = await User.find();
    const results = [];

    for (const user of users) {
      try {
        // Get user's resume
        const resumeProfile = await Resume.findOne({ userId: user._id }).lean();
        if (!resumeProfile) {
          results.push({ user: user.email, status: 'skipped', reason: 'no resume' });
          continue;
        }

        // Build keywords from resume
        const skills = resumeProfile.skills.slice(0, 5);
        const roles = resumeProfile.roles.slice(0, 3);
        const keywords = [...roles, ...skills.slice(0, 3)].filter(Boolean);

        // Scrape jobs — 85% India focus, 15% global/remote + company careers
        const indiaKeywords = keywords.map(k => `${k} india`);
        const indiaRoles = roles.map(r => `${r} india`);

        const { fetchCompanyCareers } = require('../src/scrapers/companyScraper');
        const companyJobsPromise = fetchCompanyCareers(resumeProfile).catch(() => []);

        const scrapeResults = await Promise.allSettled([
          scrapeLinkedIn(indiaKeywords),
          scrapeLinkedIn(indiaRoles),
          scrapeLinkedIn([...keywords.slice(0, 2).map(k => `${k} bangalore`), ...keywords.slice(0, 1).map(k => `${k} mumbai`)]),
          scrapeNaukri(keywords.map(k => `${k} developer`)),
          fetchRemotive(keywords),
          fetchArbeitnow(keywords),
          fetchHimalayas(keywords),
          fetchJobicy(keywords),
          fetchRemoteOK(keywords),
          fetchTheMuse(keywords),
        ]);

        const companyJobs = await companyJobsPromise;

        let allJobs = [...companyJobs];
        scrapeResults.forEach(r => { if (r.status === 'fulfilled') allJobs.push(...r.value); });

        // Dedup
        const seen = new Set();
        const unique = allJobs.filter(j => { if (seen.has(j.jobId)) return false; seen.add(j.jobId); return true; });

        // Score
        const scored = matchJobs(unique, resumeProfile, user.companyPreferences);

        // Save to DB
        let saved = 0;
        for (const job of scored) {
          try {
            await Job.findOneAndUpdate(
              { jobId: job.jobId, userId: user._id },
              { ...job, userId: user._id, foundAt: job.foundAt || new Date() },
              { upsert: true, new: true }
            );
            saved++;
          } catch (e) { /* duplicate */ }
        }

        const highMatch = scored.filter(j => j.matchScore >= 75);

        // Create report
        const report = await Report.create({
          userId: user._id,
          date: new Date(),
          jobsFound: unique.length,
          highMatch: highMatch.length,
          applied: 0,
          manualApply: highMatch.length,
          topJobs: highMatch.slice(0, 10).map(j => ({
            title: j.title, company: j.company, score: j.matchScore, link: j.applyLink,
          })),
        });

        // Send daily report notification
        await sendDailyReport(report);

        // Send instant alerts for top matches
        const minAlert = user.notifications?.minScoreAlert || 80;
        const instantJobs = highMatch.filter(j => j.matchScore >= minAlert).slice(0, 3);
        for (const job of instantJobs) {
          await sendInstantJobAlert(user, job);
        }

        results.push({
          user: user.email,
          status: 'ok',
          jobsFound: unique.length,
          saved,
          highMatch: highMatch.length,
          alertsSent: instantJobs.length,
        });
      } catch (err) {
        results.push({ user: user.email, status: 'error', error: err.message });
      }
    }

    // Also run application reminders on cron
    try {
      await sendApplicationReminders();
    } catch (e) {
      console.error('Reminder error:', e.message);
    }

    res.json({ success: true, timestamp: new Date().toISOString(), results });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
