const mongoose = require('mongoose');

// ── User Model ───────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  name:      { type: String, default: '' },
  isAdmin:   { type: Boolean, default: false },
  companyPreferences: {
    preferred: { type: [String], default: [] },
    blocked: { type: [String], default: [] },
    legacyImportedAt: { type: Date, default: null },
  },
  // Atomic per-account lock for durable automation runs.
  automationActiveRunId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // Reserve the persistent browser context while a candidate signs in or completes a manual application.
  automationInteractiveLeaseUntil: { type: Date, default: null, index: true },
  automationInteractiveLeaseKey: { type: String, default: null },
  automationContactMutationLeaseUntil: { type: Date, default: null, index: true },
  automationContactMutationLeaseToken: { type: String, default: null },
  automationContactMutationFence: { type: Number, default: 0 },
  automationStateFence: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },

  // ── Telegram Integration ──────────────────────────────────────────────────
  telegram: {
    chatId:      { type: String, default: '' },       // Telegram chat ID (set when user links via bot)
    username:    { type: String, default: '' },       // Telegram @username
    linkedAt:    { type: Date },                      // When they linked their account
    linkToken:   { type: String, default: '' },       // One-time token for linking (user sends this to bot)
    linkExpires: { type: Date },                      // Token expiry
  },

  // ── Notification Preferences ──────────────────────────────────────────────
  notifications: {
    telegram:       { type: Boolean, default: true },   // Enable Telegram notifications
    email:          { type: Boolean, default: true },   // Enable email notifications
    dailyReport:    { type: Boolean, default: true },   // Daily job hunt summary
    instantAlerts:  { type: Boolean, default: true },   // Instant alert for 80%+ match jobs
    weeklyDigest:   { type: Boolean, default: false },  // Weekly summary
    applicationReminders: { type: Boolean, default: true }, // Remind if no update on applied jobs
    minScoreAlert:  { type: Number, default: 80 },      // Only alert for jobs above this score
  },
});

// ── Job Model ─────────────────────────────────────────────────────────────────
const jobSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:       { type: String, required: true },
  company:     { type: String, required: true },
  location:    { type: String, default: 'Remote/India' },
  skills:      [String],
  experience:  { type: String },
  salary:      { type: String },
  applyLink:   { type: String, required: true },
  source:      { type: String, enum: ['LinkedIn', 'Naukri', 'Instahyre', 'Wellfound', 'Internshala', 'Remotive', 'Arbeitnow', 'Himalayas', 'Jobicy', 'RemoteOK', 'TheMuse', 'Other'] },
  description: { type: String },
  matchScore:  { type: Number, default: 0 },
  status:      { type: String, enum: ['found', 'applied', 'manual_apply', 'rejected', 'interview'], default: 'found' },
  appliedAt:   { type: Date },
  foundAt:     { type: Date, default: Date.now },
  isRemote:    { type: Boolean, default: false },
  directApply: { type: Boolean, default: false },
  jobId:       { type: String },
});
jobSchema.index({ jobId: 1, userId: 1 }, { unique: true });

// ── Resume Model ──────────────────────────────────────────────────────────────
const resumeSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rawText:        { type: String },
  skills:         [String],
  experience:     { type: Number },
  roles:          [String],
  education:      { type: String },
  name:           { type: String },
  email:          { type: String },
  updatedAt:      { type: Date, default: Date.now },
});

// ── Application Log ───────────────────────────────────────────────────────────
const applicationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  jobId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  company:   { type: String, required: true },
  title:     { type: String, required: true },
  location:  String,
  source:    String,
  applyLink: String,
  matchScore: Number,
  status:    { type: String, enum: ['applied', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'], default: 'applied' },
  appliedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  interviewDate: { type: Date },
  coverLetter: String,
  notes:     String,
  nextStep:  String,
});

// ── Daily Report ──────────────────────────────────────────────────────────────
const reportSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date:         { type: Date, default: Date.now },
  jobsFound:    { type: Number, default: 0 },
  highMatch:    { type: Number, default: 0 },
  applied:      { type: Number, default: 0 },
  manualApply:  { type: Number, default: 0 },
  topJobs:      [{ title: String, company: String, score: Number, link: String }],
});

// Durable run records let an API process enqueue work without keeping an HTTP
// request open. Ownership is always derived from the authenticated user.
const automationRunSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['job-hunt', 'browser-automation'], required: true, default: 'job-hunt' },
  // Browser tasks must run beside the local Playwright profile that accepted them.
  targetWorkerId: { type: String, default: null, index: true },
  idempotencyKey: { type: String, default: null },
  mode: { type: String, enum: ['daily', 'discover', 'apply', 'dry-run', 'verification'], default: null },
  jobId: { type: String, default: null },
  status: { type: String, enum: ['queued', 'running', 'complete', 'failed', 'interrupted'], required: true, default: 'queued', index: true },
  progress: { type: Number, default: 0 },
  step: { type: String, default: 'queued' },
  logs: [{ time: Date, message: String }],
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  error: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  workerId: { type: String, default: null },
  workerSlotId: { type: String, default: null },
  leaseUntil: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
}, { minimize: false });
automationRunSchema.index({ userId: 1, createdAt: -1 });
automationRunSchema.index({ status: 1, createdAt: 1 });
automationRunSchema.index({ type: 1, status: 1, targetWorkerId: 1, createdAt: 1 });
automationRunSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

const automationJobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  jobId: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  descriptionFile: { type: String, default: null },
  migratedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });
automationJobSchema.index({ userId: 1, jobId: 1 }, { unique: true });
automationJobSchema.index({ userId: 1, 'data.status': 1, 'data.discoveredAt': -1 });

const automationAccountStateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  revision: { type: Number, default: 0 },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  answers: { type: mongoose.Schema.Types.Mixed, default: {} },
  excludedCompanies: { type: [String], default: [] },
  runs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  events: { type: [mongoose.Schema.Types.Mixed], default: [] },
  extra: { type: mongoose.Schema.Types.Mixed, default: {} },
  source: { type: String, enum: ['local-migration', 'portal'], default: 'local-migration' },
  migratedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

const automationWorkerSlotSchema = new mongoose.Schema({
  _id: { type: String },
  workerId: { type: String, default: null, index: true },
  runId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  leaseUntil: { type: Date, default: null, index: true },
}, { versionKey: false });

const automationQueueConfigSchema = new mongoose.Schema({
  _id: { type: String },
  globalMaxRuns: { type: Number, required: true, min: 1, max: 100 },
}, { versionKey: false });

const automationWorkerInstanceSchema = new mongoose.Schema({
  _id: { type: String },
  lastSeenAt: { type: Date, required: true, index: true },
}, { versionKey: false });

const automationProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  revision: { type: Number, default: 0 },
  source: { type: String, enum: ['local-migration', 'portal'], default: 'local-migration' },
  migratedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

const automationCredentialSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  encryptedSecret: { type: mongoose.Schema.Types.Mixed, required: true },
  verifiedAt: { type: Date, default: null },
}, { timestamps: true, minimize: false });

const automationContactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contactId: { type: String, required: true },
  email: { type: String, required: true, trim: true },
  emailNormalized: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, default: '' },
  companies: { type: [String], default: [] },
  sourceFiles: { type: [String], default: [] },
  firstImportedAt: { type: Date },
  lastImportedAt: { type: Date },
  importCount: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
}, { timestamps: true });
automationContactSchema.index({ userId: 1, emailNormalized: 1 }, { unique: true });
automationContactSchema.index({ userId: 1, status: 1, lastImportedAt: -1 });

const automationCampaignSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  campaignId: { type: String, required: true },
  status: { type: String, enum: ['sending', 'completed', 'completed_with_errors', 'failed', 'interrupted'], required: true, index: true },
  total: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null, index: true },
  leaseToken: { type: String, default: null },
  results: { type: [mongoose.Schema.Types.Mixed], default: [] },
  error: { type: String, default: null },
}, { timestamps: true, minimize: false });
automationCampaignSchema.index({ userId: 1, campaignId: 1 }, { unique: true });
automationCampaignSchema.index({ userId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'sending' } });
automationCampaignSchema.index({ userId: 1, createdAt: -1 });

const authRateLimitSchema = new mongoose.Schema({
  _id: { type: String },
  windowStart: { type: Date, required: true },
  count: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
authRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const systemBootstrapSchema = new mongoose.Schema({
  _id: { type: String },
  firstAdminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { versionKey: false });

const notificationDeliverySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deliveryKey: { type: String, required: true },
  status: { type: String, enum: ['sending', 'sent', 'failed'], required: true, default: 'sending' },
  attemptedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
notificationDeliverySchema.index({ userId: 1, deliveryKey: 1 }, { unique: true });
notificationDeliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  User:        mongoose.model('User', userSchema),
  Job:         mongoose.model('Job', jobSchema),
  Resume:      mongoose.model('Resume', resumeSchema),
  Application: mongoose.model('Application', applicationSchema),
  Report:      mongoose.model('Report', reportSchema),
  AutomationRun: mongoose.model('AutomationRun', automationRunSchema),
  AutomationJob: mongoose.model('AutomationJob', automationJobSchema),
  AutomationAccountState: mongoose.model('AutomationAccountState', automationAccountStateSchema),
  AutomationWorkerSlot: mongoose.model('AutomationWorkerSlot', automationWorkerSlotSchema),
  AutomationQueueConfig: mongoose.model('AutomationQueueConfig', automationQueueConfigSchema),
  AutomationWorkerInstance: mongoose.model('AutomationWorkerInstance', automationWorkerInstanceSchema),
  AutomationProfile: mongoose.model('AutomationProfile', automationProfileSchema),
  AutomationCredential: mongoose.model('AutomationCredential', automationCredentialSchema),
  AutomationContact: mongoose.model('AutomationContact', automationContactSchema),
  AutomationCampaign: mongoose.model('AutomationCampaign', automationCampaignSchema),
  AuthRateLimit: mongoose.model('AuthRateLimit', authRateLimitSchema),
  SystemBootstrap: mongoose.model('SystemBootstrap', systemBootstrapSchema),
  NotificationDelivery: mongoose.model('NotificationDelivery', notificationDeliverySchema),
};
