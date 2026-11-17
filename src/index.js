require('dotenv').config();
// Personal local mode runs without MongoDB after a confirmed profile has been initialized.
if (!process.env.VERCEL && !process.env.MONGODB_URI && require('fs').existsSync(require('path').join(__dirname, '../.automation/profile.json'))) {
  module.exports = require('./automation/server');
  if (require.main === module) module.exports.start();
  return;
}
const express   = require('express');
const mongoose  = require('mongoose');
const { getMongoOptions } = require('./mongoOptions');
const cors      = require('cors');
const path      = require('path');
const routes    = require('./routes');
const automationApp = require('./automation/server').app;

const app  = express();
const PORT = process.env.PORT || 3000;
const trustProxyHops = process.env.TRUST_PROXY_HOPS === undefined
  ? (process.env.VERCEL ? 1 : false)
  : Number(process.env.TRUST_PROXY_HOPS);
if (trustProxyHops !== false && (!Number.isInteger(trustProxyHops) || trustProxyHops < 1 || trustProxyHops > 5)) {
  throw new Error('TRUST_PROXY_HOPS must be an integer from 1 to 5.');
}
app.set('trust proxy', trustProxyHops);

// ── Connect MongoDB ───────────────────────────────────────────────────────────
let dbConnectPromise = null;
async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!dbConnectPromise) {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/naukri-khojo';
    dbConnectPromise = mongoose.connect(uri, getMongoOptions())
      .then(connection => {
        console.log(`✅ MongoDB connected (${connection.connection.name})`);
        return connection;
      })
      .catch(error => {
        console.error('❌ MongoDB connection failed:', error.message);
        throw error;
      })
      .finally(() => { dbConnectPromise = null; });
  }
  return dbConnectPromise;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Lazy DB connection for serverless ─────────────────────────────────────────
app.use('/api', async (req, res, next) => {
  try { await connectDB(); }
  catch { return res.status(503).json({ error: 'MongoDB is unavailable. Check the connection string, credentials, and Atlas Network Access IP allowlist, then retry.' }); }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── Automation API Routes (mounted under /automation) ────────────────────────
app.use('/automation', automationApp);

// ── Telegram Webhook (public endpoint — Telegram sends updates here) ─────────
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const { handleWebhook } = require('./notifiers/telegramBot');
    const { User } = require('./models');
    await handleWebhook(req, User);
    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
    res.sendStatus(200); // Always 200 to prevent Telegram retries
  }
});

// ── Serve Dashboard ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Cron Scheduler ────────────────────────────────────────────────────────────
if (!process.env.VERCEL) {
  const cron = require('node-cron');
  const { runJobHunt } = require('./runner');
  const { sendApplicationReminders, sendWeeklyDigest } = require('./notifiers/notifier');
  const { User, Resume } = require('./models');
  const { enqueueJobHunt, dailyJobHuntIdempotencyKey } = require('./automationQueue');

  // Daily job hunt at 8:00 AM IST — runs for ALL users with a resume
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Cron triggered — starting daily job hunt for all users');
    try {
      const idempotencyKey = dailyJobHuntIdempotencyKey();
      const users = await User.find();
      for (const user of users) {
        try {
          if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
            if (await Resume.exists({ userId: user._id })) await enqueueJobHunt(user._id, { idempotencyKey });
          } else {
            await runJobHunt(user._id, true); // legacy local scheduler
          }
        } catch (err) {
          console.error(`Hunt failed for ${user.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Cron run failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Application reminders at 10:00 AM IST — Mon/Wed/Fri
  cron.schedule('0 10 * * 1,3,5', async () => {
    console.log('⏰ Sending application follow-up reminders');
    try {
      await sendApplicationReminders();
    } catch (err) {
      console.error('Reminder cron failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // Weekly digest at 9:00 AM IST on Sundays
  cron.schedule('0 9 * * 0', async () => {
    console.log('⏰ Sending weekly digest');
    try {
      await sendWeeklyDigest();
    } catch (err) {
      console.error('Weekly digest cron failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

// ── Start Server (local only) ────────────────────────────────────────────────
if (!process.env.VERCEL) {
  (async () => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Naukri Khojo running at http://localhost:${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔌 API:       http://localhost:${PORT}/api/jobs`);
      console.log(`⏰ Cron:      Daily at 8:00 AM IST\n`);
    });

    try {
      await connectDB();
      // Start Telegram bot polling only after MongoDB is ready.
      const { deleteWebhook, startPolling } = require('./notifiers/telegramBot');
      const { User } = require('./models');
      await deleteWebhook();
      startPolling(User);
      console.log('🤖 Telegram:  Bot polling active');
    } catch (error) {
      console.error('MongoDB is unavailable at startup. The dashboard is up; API requests will retry the connection.');
    }
  })();
}

module.exports = app;
