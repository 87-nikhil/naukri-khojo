require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const store = require('./store');
const runner = require('./runner');
const { COMPANIES, PLATFORMS } = require('./companies');
const { importJob } = require('./discovery');
const { normalize } = require('./answers');
const { evaluate } = require('./matching');
const browser = require('./browser');
const { parseDocument, extractProfile } = require('./profileImport');
const { JWT_SECRET } = require('../authSecret');
const { User, AutomationRun } = require('../models');
const { connectQueueDb, enqueueBrowserAutomation } = require('../automationQueue');
const userData = require('./userData');
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const coldAttachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
function isRunning() { return runner.isRunning() || store.workerActive(); }
function hasRunnableProfile(profile = store.read('profile', null)) {
  return !!(profile?.name && profile?.email && profile?.resumeFile && Array.isArray(profile.cities) && profile.cities.length);
}
const PORT = Number(process.env.AUTOMATION_PORT || 4129);
const INTERACTIVE_LEASE_MS = Math.max(60_000, Number(process.env.AUTOMATION_INTERACTIVE_LEASE_MS) || 30 * 60_000);
const automationInstanceId = process.env.AUTOMATION_INSTANCE_ID || `${require('node:os').hostname()}-${crypto.createHash('sha256').update(store.BASE_ROOT).digest('hex').slice(0, 24)}`;
if (!/^[a-z\d_.:-]{1,160}$/i.test(automationInstanceId)) throw new Error('AUTOMATION_INSTANCE_ID must use letters, numbers, dots, underscores, colons, or hyphens (max 160 characters).');
const token = crypto.randomBytes(32).toString('hex');
const portalSessions = new Map();
const usedSsoNonces = new Map();
const localInteractiveLeases = new Map();
async function accountBusy(userId, { allowInteractive = false } = {}) {
  if (isRunning()) return true;
  if (process.env.AUTOMATION_QUEUE_ENABLED !== 'true') {
    return !allowInteractive && (localInteractiveLeases.get(String(userId))?.expiresAt || 0) > Date.now();
  }
  await connectQueueDb();
  const filter = { _id: userId, automationActiveRunId: { $ne: null } };
  if (!allowInteractive) filter.automationInteractiveLeaseUntil = { $gt: new Date() };
  return !!(await User.exists(filter));
}
async function reserveInteractiveBrowser(userId, leaseKey) {
  if (!leaseKey) throw new Error('An interactive browser session key is required.');
  const expiresAt = new Date(Date.now() + INTERACTIVE_LEASE_MS);
  if (process.env.AUTOMATION_QUEUE_ENABLED !== 'true') {
    if (runner.isRunning() || store.workerActive()) return null;
    const current = localInteractiveLeases.get(String(userId));
    if (current && current.expiresAt > Date.now() && current.leaseKey !== leaseKey) return null;
    localInteractiveLeases.set(String(userId), { expiresAt: expiresAt.getTime(), leaseKey });
    return expiresAt;
  }
  await connectQueueDb();
  const user = await User.findOneAndUpdate(
    { _id: userId, $and: [
      { $or: [{ automationActiveRunId: null }, { automationActiveRunId: { $exists: false } }] },
      { $or: [
        { automationInteractiveLeaseUntil: null },
        { automationInteractiveLeaseUntil: { $exists: false } },
        { automationInteractiveLeaseUntil: { $lte: new Date() } },
        { automationInteractiveLeaseKey: leaseKey },
      ] },
    ] },
    { $set: { automationInteractiveLeaseUntil: expiresAt, automationInteractiveLeaseKey: leaseKey } },
    { new: true, projection: { _id: 1 } }
  );
  return user ? expiresAt : null;
}
async function releaseInteractiveBrowser(userId, leaseKey) {
  if (!leaseKey) return;
  if (process.env.AUTOMATION_QUEUE_ENABLED !== 'true') {
    const current = localInteractiveLeases.get(String(userId));
    if (current?.leaseKey === leaseKey) localInteractiveLeases.delete(String(userId));
    return;
  }
  await connectQueueDb();
  await User.updateOne(
    { _id: userId, automationInteractiveLeaseKey: leaseKey },
    { $set: { automationInteractiveLeaseUntil: null, automationInteractiveLeaseKey: null } }
  );
}
function browserLeaseKey(req) {
  if (!req.portalSession.interactiveLeaseKey) req.portalSession.interactiveLeaseKey = crypto.randomUUID();
  return req.portalSession.interactiveLeaseKey;
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) return res.sendStatus(403);
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Naukri-Khojo-Token') !== token) return res.status(403).json({ error: 'Open the local dashboard to perform this action' });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const protectedResource = req.path.startsWith('/api/') || req.path.startsWith('/reports/') || req.path.startsWith('/evidence/');
  if (!protectedResource || (req.method === 'POST' && req.path === '/api/session/accept')) return next();
  const bearer = req.get('Authorization') || '';
  const cookieToken = (req.headers.cookie || '').match(/(?:^|;\s*)automation_session=([^;]+)/)?.[1] || '';
  const sessionToken = bearer.startsWith('Bearer ') ? bearer.slice(7) : cookieToken;
  const session = portalSessions.get(sessionToken);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) portalSessions.delete(sessionToken);
    res.setHeader('Set-Cookie', 'automation_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return res.status(401).json({ error: 'Sign in through the main Naukri Khojo portal to access automation.' });
  }
  session.lastSeenAt = Date.now();
  req.portalSession = session;
  req.portalAccount = session.account;
  store.runAsUser(session.account.userId, next);
});
app.use(async (req, res, next) => {
  if (process.env.AUTOMATION_QUEUE_ENABLED !== 'true' || !req.portalAccount || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const writesState = req.path === '/api/profile' || req.path === '/api/settings' || req.path === '/api/exclusions' ||
    req.path === '/api/jobs/import' || req.path === '/api/questions/answer' || req.path === '/api/inbox/scan' ||
    req.path === '/api/email/connect' || /^\/api\/(?:linkedin\/[^/]+|jobs\/[^/]+\/(?:verify|archive|answers|finish|outcome|reconcile))$/.test(req.path);
  if (!writesState) return next();
  try {
    await connectQueueDb();
    if (await User.exists({ _id: req.portalAccount.userId, automationActiveRunId: { $ne: null } })) {
      return res.status(409).json({ error: 'Automation is processing this account. Retry the change when the run finishes.' });
    }
    await userData.loadAutomationState(req.portalAccount.userId);
    const sendJson = res.json.bind(res);
    let persisting = false;
    res.json = body => {
      if (persisting || res.locals.automationStatePersisted) return sendJson(body);
      persisting = true;
      userData.saveAutomationState(req.portalAccount.userId, store.state())
        .then(() => sendJson(body))
        .catch(error => {
          console.error('Could not persist automation state:', error.message);
          if (!res.headersSent) {
            const conflict = error.message.includes('changed in another request');
            res.statusCode = conflict ? 409 : 500;
            sendJson({ error: conflict ? error.message : 'Could not save automation state. Reload the page and retry.' });
          }
        });
      return res;
    };
    next();
  } catch (error) { next(error); }
});
app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && !req.path.startsWith('/api/session/')) {
    res.on('finish', () => {
      try {
        const save = () => require('./reports').save(undefined, undefined, { share: true });
        Promise.resolve(req.portalAccount?.userId ? store.runAsUser(req.portalAccount.userId, save) : save())
          .catch(e => console.error('Report save failed:', e.message));
      } catch (e) { console.error('Report save failed:', e.message); }
    });
  }
  next();
});
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/automation.html'), 'utf8').replace('__LOCAL_TOKEN__', token);
  res.type('html').send(html);
});
app.post('/api/session/accept', async (req, res) => {
  let signInLeaseKey = null;
  let signInUserId = null;
  try {
    const claims = jwt.verify(String(req.body?.ticket || ''), JWT_SECRET, {
      issuer: 'naukri-khojo', audience: 'naukri-khojo-local-automation',
    });
    if (claims.purpose !== 'automation-sso' || !claims.sub || !claims.nonce || !claims.profile?.email) {
      return res.status(401).json({ error: 'This sign-in link is invalid. Open automation from the signed-in main portal again.' });
    }
    signInUserId = claims.sub;
    for (const [nonce, expiresAt] of usedSsoNonces) if (expiresAt <= Date.now()) usedSsoNonces.delete(nonce);
    if (usedSsoNonces.has(claims.nonce)) return res.status(401).json({ error: 'This sign-in link has already been used. Open automation from the main portal again.' });

    const incomingAccountEmail = String(claims.profile.accountEmail || claims.profile.email).trim().toLowerCase();
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
      signInLeaseKey = crypto.randomUUID();
      if (!await reserveInteractiveBrowser(claims.sub, signInLeaseKey)) {
        signInLeaseKey = null;
        return res.status(409).json({ error: 'Automation or another browser session is active for this account. Sign in again when it finishes.' });
      }
    }
    store.prepareUserScope(claims.sub, incomingAccountEmail);
    return await store.runAsUser(claims.sub, async () => {
    await userData.loadProfile(claims.sub);
    await userData.loadContacts(claims.sub);
    await userData.loadCredentials(claims.sub);
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') await userData.loadAutomationState(claims.sub);
    const owner = store.read('portal-owner', null);
    const currentProfile = store.read('profile', null);
    const existingState = store.state();
    const ownerEmail = String(owner?.email || '').trim().toLowerCase();
    const ownerProfileMatches = currentProfile?.portalUserId === owner?.userId;
    // Portal accounts can be recreated with a new database ID while retaining the same verified email.
    // Allow that recovery only when both the stored owner and synced profile confirm the old binding.
    const sameAccountRecovery = owner && owner.userId !== claims.sub && ownerEmail &&
      ownerEmail === incomingAccountEmail && ownerProfileMatches;
    if (owner && owner.userId !== claims.sub && !sameAccountRecovery) {
      return res.status(403).json({ error: 'This automation data directory is linked to another portal account.' });
    }
    if (!owner && currentProfile?.email && currentProfile.email.toLowerCase() !== String(claims.profile.email).toLowerCase() && currentProfile.email.toLowerCase() !== String(claims.profile.accountEmail || '').toLowerCase()) {
      return res.status(409).json({ error: 'The saved local candidate profile belongs to a different email. Resolve the profile ownership before linking accounts.' });
    }
    if (!owner && existingState.jobs.length && (!currentProfile?.email || (currentProfile.email.toLowerCase() !== String(claims.profile.email).toLowerCase() && currentProfile.email.toLowerCase() !== String(claims.profile.accountEmail || '').toLowerCase()))) {
      return res.status(409).json({ error: 'Existing automation jobs have no linked profile owner. Initialize or separate the local data before linking this account.' });
    }

    const incoming = claims.profile;
    const existing = currentProfile || {};
    const skills = [...new Set([...(Array.isArray(existing.skills) ? existing.skills : []), ...(Array.isArray(incoming.skills) ? incoming.skills : [])])].slice(0, 100);
    const keywords = [...new Set([...(existing.searchKeywords || []), ...(incoming.searchKeywords || [])])].slice(0, 100);
    const syncedName = incoming.name || existing.name || '';
    const nameParts = syncedName.trim().split(/\s+/).filter(Boolean);
    const synced = {
      ...existing,
      name: syncedName,
      firstName: incoming.name ? (nameParts.shift() || '') : existing.firstName || '',
      lastName: incoming.name ? nameParts.join(' ') : existing.lastName || '',
      email: incoming.email || existing.email || '',
      skills,
      experienceYears: incoming.experienceYears ?? existing.experienceYears ?? null,
      searchKeywords: keywords,
      portalUserId: claims.sub,
      portalProfileSyncedAt: new Date().toISOString(),
    };
    store.write('portal-owner', { userId: claims.sub, email: incoming.accountEmail || incoming.email, linkedAt: new Date().toISOString() });
    if (!currentProfile) {
      store.mutate(state => { state.settings.paused = true; state.settings.autoApply = false; });
      store.event('New portal account linked; automation starts paused until its owner reviews profile and settings');
      if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') await userData.saveAutomationState(claims.sub, store.state());
    }
    await userData.saveProfile(claims.sub, synced);
    usedSsoNonces.set(claims.nonce, claims.exp * 1000);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const account = { userId: claims.sub, email: incoming.accountEmail || incoming.email, name: incoming.name || '' };
    portalSessions.set(sessionToken, { account, expiresAt: Date.now() + 12 * 60 * 60 * 1000, lastSeenAt: Date.now() });
    if (signInLeaseKey) {
      await releaseInteractiveBrowser(claims.sub, signInLeaseKey);
      signInLeaseKey = null;
    }
    res.setHeader('Set-Cookie', `automation_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    res.json({ ok: true, sessionToken, expiresIn: 43200, account, profileSynced: true });
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'The sign-in link expired. Open automation from the signed-in main portal again.' });
    if (error.name === 'JsonWebTokenError' || error.name === 'NotBeforeError') return res.status(401).json({ error: 'The portal and local worker signing keys do not match. Set the same JWT_SECRET in both environments, restart them, and open automation again.' });
    console.error('Automation portal sign-in failed:', error.message);
    res.status(500).json({ error: 'Could not sign in to automation. Try opening it again from the main portal.' });
  } finally {
    if (signInLeaseKey) await releaseInteractiveBrowser(signInUserId, signInLeaseKey).catch(error => console.error('Could not release sign-in reservation:', error.message));
  }
});
app.post('/api/session/logout', (req, res) => {
  const cookieToken = (req.headers.cookie || '').match(/(?:^|;\s*)automation_session=([^;]+)/)?.[1] || '';
  const sessionToken = (req.get('Authorization') || '').replace(/^Bearer\s+/, '') || cookieToken;
  if (sessionToken) portalSessions.delete(sessionToken);
  res.setHeader('Set-Cookie', 'automation_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/state', async (req, res, next) => {
  try {
  const p = await userData.loadProfile(req.portalAccount.userId);
  let queueRun = null;
  if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
    await connectQueueDb();
    queueRun = await AutomationRun.findOne({ userId: req.portalAccount.userId, status: { $in: ['queued', 'running'] } })
      .select('_id type mode status createdAt startedAt step progress error').sort({ createdAt: -1 }).lean();
  }
  // A live worker owns its scoped JSON working copy until it commits the run snapshot.
  // Reading Mongo mid-run into that same file would overwrite in-flight local mutations.
  const liveBrowserRun = queueRun?.type === 'browser-automation' && queueRun.status === 'running';
  const s = process.env.AUTOMATION_QUEUE_ENABLED !== 'true' || liveBrowserRun
    ? store.state()
    : await userData.loadAutomationState(req.portalAccount.userId, { writeCache: false });
  // Job descriptions are most of the state file (80+ MB); the dashboard fetches one only when you open it.
  const slim = ({ description, attempts, match, descriptionFile, ...j }) => ({ ...j, hasDescription: !!description || !!descriptionFile, match: match && { score: match.score, eligible: match.eligible, blocked: match.blocked, reasons: match.reasons, salaryStatus: match.salaryStatus } });
  res.json({ ...s, jobs: s.jobs.map(slim), profile: p, portalAccount: req.portalAccount, companies: COMPANIES, companyStatus: store.read('companies-status', []), platforms: PLATFORMS, platformStatus: store.read('platform-status', []), running: isRunning() || !!queueRun, queueRun, day: store.indiaDay(), confirmedToday: runner.todays(s).length });
  } catch (error) { next(error); }
});
app.post('/api/profile/preview', resumeUpload.single('resume'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or DOCX resume first' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const validPdf = ext === '.pdf' && req.file.buffer.subarray(0, 5).toString() === '%PDF-';
    const validDocx = ext === '.docx' && req.file.buffer.subarray(0, 2).toString() === 'PK';
    if (!validPdf && !validDocx) return res.status(400).json({ error: 'File type does not match a valid PDF or DOCX resume' });
    const text = await parseDocument(req.file.buffer, req.file.originalname);
    const { extractedText, ...suggestions } = extractProfile(text, req.file.originalname);
    res.json({ suggestions });
  } catch (error) { next(error); }
});
app.post('/api/profile', resumeUpload.single('resume'), async (req, res, next) => {
  try {
    if (await accountBusy(req.portalAccount.userId)) return res.status(409).json({ error: 'Wait for the current run to finish before updating your profile' });
    let ext, text, originalName;
    if (req.file) {
      ext = path.extname(req.file.originalname).toLowerCase();
      const validPdf = ext === '.pdf' && req.file.buffer.subarray(0, 5).toString() === '%PDF-';
      const validDocx = ext === '.docx' && req.file.buffer.subarray(0, 2).toString() === 'PK';
      if (!validPdf && !validDocx) return res.status(400).json({ error: 'File type does not match a valid PDF or DOCX resume' });
      text = await parseDocument(req.file.buffer, req.file.originalname);
      originalName = req.file.originalname;
    }
    let values;
    try { values = JSON.parse(req.body.profile || ''); } catch { return res.status(400).json({ error: 'Profile form data is invalid' }); }
    const list = (value, max = 30) => Array.isArray(value) ? [...new Set(value.map(x => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, max) : [];
    const number = (value, max) => { if (value === undefined || value === null || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
    const name = String(values.name || '').trim().slice(0, 120);
    const email = String(values.email || '').trim().slice(0, 254);
    const cities = list(values.cities, 20);
    const genderOptions = ['Female', 'Male', 'Non-binary', 'Other / self-describe', 'Prefer not to say'];
    const gender = genderOptions.includes(values.gender) ? values.gender : '';
    const workAuthOptions = ['authorized_india', 'needs_sponsorship', 'not_authorized'];
    const workAuthorization = workAuthOptions.includes(values.workAuthorization) ? values.workAuthorization : '';
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !cities.length) return res.status(400).json({ error: 'Enter a name, valid email, and at least one preferred city' });
    const original = store.read('profile', { cities: [], skills: [], years: {}, excludedCompanies: [], standingAnswers: {}, employment: [], education: {}, authorized: { autoSubmit: false }, coverLetter: '' });
    let filename = original.resumeFile || '';
    if (req.file) {
      filename = `resume-${crypto.randomUUID()}${ext}`;
      await require('./userFiles').saveFile(filename, 'resume', req.file.buffer, ext === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } else if (!filename || !await require('./userFiles').ensureLocalFile(filename, 'resume')) {
      return res.status(400).json({ error: 'Upload a PDF or DOCX resume before saving this profile' });
    } else {
      await require('./userFiles').ensureSharedFile(filename, 'resume');
    }
    const startYear = number(values.education?.startYear, 2100);
    const endYear = number(values.education?.endYear, 2100);
    const years = Object.fromEntries(Object.entries(values.years || {}).slice(0, 60).map(([skill, value]) => [String(skill).trim().slice(0, 80), number(value, 60)]).filter(([skill, value]) => skill && value !== null));
    if (!Array.isArray(values.employment) || values.employment.length > 20 || values.employment.some(item => !item || typeof item.company !== 'string' || typeof item.title !== 'string')) return res.status(400).json({ error: 'Employment history must be a JSON list of company/title records' });
    const employment = values.employment.map(item => ({
      company: item.company.trim().slice(0, 160),
      title: item.title.trim().slice(0, 160),
      start: String(item.start || '').trim().slice(0, 40),
      end: String(item.end || '').trim().slice(0, 40),
    })).filter(item => item.company && item.title);
    const updated = {
      ...original,
      name,
      firstName: String(values.firstName || '').trim().slice(0, 80),
      lastName: String(values.lastName || '').trim().slice(0, 80),
      email,
      phone: String(values.phone || '').trim().slice(0, 40),
      gender,
      workAuthorization,
      currentTitle: String(values.currentTitle || '').trim().slice(0, 160),
      currentCompany: String(values.currentCompany || '').trim().slice(0, 160),
      currentCity: String(values.currentCity || '').trim().slice(0, 100),
      excludedCompanies: [...new Set([...(original.excludedCompanies || []), String(values.currentCompany || '').trim()].filter(Boolean))],
      experienceYears: number(values.experienceYears, 60) ?? original.experienceYears,
      cities,
      skills: list(values.skills, 60),
      searchKeywords: list(values.searchKeywords, 30),
      currentCtcLpa: number(values.currentCtcLpa, 1000),
      minimumCtcLpa: number(values.minimumCtcLpa, 1000),
      expectedCtcLpa: number(values.expectedCtcLpa, 1000),
      maximumCtcLpa: number(values.maximumCtcLpa, 1000),
      noticeDays: number(values.noticeDays, 365) ?? 0,
      noticeNegotiable: values.noticeNegotiable === true,
      holdingOffer: values.holdingOffer === true,
      employmentType: String(values.employmentType || 'Full-time').trim().slice(0, 80),
      remoteCountry: String(values.remoteCountry || 'India').trim().slice(0, 80),
      education: {
        ...(original.education || {}),
        degree: String(values.education?.degree || '').trim().slice(0, 160),
        institution: String(values.education?.institution || '').trim().slice(0, 200),
        startYear: startYear ?? 0,
        endYear: endYear ?? 0,
      },
      employment,
      years,
      coverLetter: String(values.coverLetter || '').slice(0, 5000),
      resumeFile: filename,
      resumeOriginalName: req.file ? String(originalName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) : original.resumeOriginalName,
      resumeText: text || original.resumeText || '',
      authorized: { ...(original.authorized || {}), autoSubmit: false },
    };
    store.mutate(s => { s.settings.paused = true; s.settings.autoApply = false; });
    store.event('Candidate profile updated from a reviewed resume and profile form');
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
      await userData.saveAutomationState(req.portalAccount.userId, store.state());
      res.locals.automationStatePersisted = true;
    }
    await userData.saveProfile(req.portalAccount.userId, updated);
    res.json({ ok: true, profile: updated });
  } catch (error) { next(error); }
});
app.get('/api/jobs/:id/description', async (req, res, next) => {
  try {
    const runningBrowserRun = process.env.AUTOMATION_QUEUE_ENABLED === 'true' && await AutomationRun.exists({ userId: req.portalAccount.userId, type: 'browser-automation', status: 'running' });
    const state = process.env.AUTOMATION_QUEUE_ENABLED !== 'true' || runningBrowserRun
      ? store.state()
      : await userData.loadAutomationState(req.portalAccount.userId, { writeCache: false });
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job) return res.sendStatus(404);
    const description = job.description || await userData.readJobDescription(req.portalAccount.userId, job.descriptionFile);
    res.json({ description });
  } catch (error) { next(error); }
});
app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'local-automation', running: isRunning(), browserMode: 'headless', browserActive: browser.isBackground() }));
app.get('/api/email/status', (req, res) => res.json(require('./email').status()));
app.get('/api/inbox', (req, res) => res.json(require('./inbox').summary()));
app.post('/api/inbox/scan', async (req, res, next) => { try { await require('./inbox').scan(); res.json(require('./inbox').summary()); } catch (e) { next(e); } });
app.get('/api/shortlist', (req, res) => res.json(require('./shortlist').build()));
app.post('/api/email/connect', async (req, res, next) => {
  try {
    const email = require('./email');
    const credentials = await email.verifyConnection(req.body.email, req.body.appPassword, runner.profile().email);
    await userData.saveCredentials(req.portalAccount.userId, credentials);
    store.event('Gmail verification connection authenticated and saved securely');
    res.json(email.status());
  } catch (error) { next(error); }
});
app.post('/api/cold-email/extract', coldAttachmentUpload.single('sheet'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an XLSX or CSV sheet first.' });
    res.json(await require('./coldEmail').extractContacts(req.file.buffer, req.file.originalname));
  } catch (error) { next(error); }
});
app.get('/api/cold-email/contacts', async (req, res, next) => {
  try { await userData.loadContacts(req.portalAccount.userId); res.json(require('./coldEmail').listContacts({ query: req.query.query, company: req.query.company, status: req.query.status, page: req.query.page, limit: req.query.limit })); }
  catch (error) { next(error); }
});
app.post('/api/cold-email/contacts/import', async (req, res, next) => {
  try { await userData.withContactMutationLock(req.portalAccount.userId, async leaseToken => { await userData.loadContacts(req.portalAccount.userId); const result = require('./coldEmail').importContacts(req.body.contacts, req.body.sourceFile, req.body.duplicateCount); await userData.saveContacts(req.portalAccount.userId, store.read('company-contacts', []), { leaseToken }); res.json({ ok: true, ...result }); }); }
  catch (error) { next(error); }
});
app.patch('/api/cold-email/contacts/:id', async (req, res, next) => {
  try { await userData.withContactMutationLock(req.portalAccount.userId, async leaseToken => { await userData.loadContacts(req.portalAccount.userId); const contact = require('./coldEmail').updateContact(req.params.id, req.body); if (!contact) return res.sendStatus(404); await userData.saveContacts(req.portalAccount.userId, store.read('company-contacts', []), { leaseToken }); res.json({ ok: true, contact }); }); }
  catch (error) { next(error); }
});
app.delete('/api/cold-email/contacts/:id', async (req, res, next) => {
  try { await userData.withContactMutationLock(req.portalAccount.userId, async leaseToken => { await userData.loadContacts(req.portalAccount.userId); if (!require('./coldEmail').deleteContact(req.params.id)) return res.sendStatus(404); await userData.saveContacts(req.portalAccount.userId, store.read('company-contacts', []), { leaseToken }); res.json({ ok: true }); }); }
  catch (error) { next(error); }
});
app.post('/api/cold-email/send', coldAttachmentUpload.single('attachment'), async (req, res, next) => {
  try {
    await userData.loadContacts(req.portalAccount.userId);
    const contactIds = JSON.parse(req.body.contactIds || 'null');
    const started = await require('./coldEmail').startCampaign({ contactIds, subject: req.body.subject, text: req.body.text, attachment: req.file, attested: req.body.attested === 'true' });
    res.status(202).json(started);
  } catch (error) { next(error); }
});
app.get('/api/cold-email/status/:id', async (req, res, next) => {
  const coldEmail = require('./coldEmail'); coldEmail.cleanup();
  try {
    const result = await coldEmail.status(req.params.id);
    if (!result) return res.sendStatus(404);
    res.json(result);
  } catch (error) { next(error); }
});
app.post('/api/jobs/:id/verify', async (req, res, next) => {
  try {
  const interactiveLeaseKey = req.portalSession.interactiveLeaseKey || undefined;
  if (await accountBusy(req.portalAccount.userId, { allowInteractive: !!interactiveLeaseKey })) return res.status(409).json({ error: 'A run is already active' });
  if (process.env.AUTOMATION_QUEUE_ENABLED !== 'true' && !runner.hasCapacity()) return res.status(429).json({ error: 'The automation worker is busy. Try again when an active run finishes.' });
  if (!/^[A-Za-z0-9]{8}$/.test(req.body.code || '')) return res.status(400).json({ error: 'Enter the 8-character email security code' });
  const s = store.state(), j = s.jobs.find(j => j.id === req.params.id);
  if (!j || !['needs_input', 'submission_uncertain'].includes(j.status)) return res.status(400).json({ error: 'Select the application waiting for verification' });
  if (!evaluate(j, runner.profile()).eligible) return res.status(400).json({ error: 'This job is outside your confirmed preferences' });
  const prior = { status: j.status, reason: j.reason };
  store.mutate(value => { const job = value.jobs.find(job => job.id === j.id); job.status = 'queued'; job.reason = 'Candidate supplied a one-time email verification code'; });
  if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
    await userData.saveAutomationState(req.portalAccount.userId, store.state());
    res.locals.automationStatePersisted = true;
    const restore = async () => {
      store.mutate(value => { const job = value.jobs.find(job => job.id === j.id); if (job) Object.assign(job, prior); });
      await userData.saveAutomationState(req.portalAccount.userId, store.state());
    };
    try {
      await connectQueueDb();
      const queued = await enqueueBrowserAutomation(req.portalAccount.userId, { mode: 'verification', jobId: j.id, verificationCode: req.body.code, interactiveLeaseKey, targetWorkerId: automationInstanceId });
      if (!queued.accepted) {
        await restore();
        return res.status(409).json({ error: queued.interactiveLeaseUntil && queued.interactiveLeaseUntil > new Date() && !interactiveLeaseKey ? 'Finish platform sign-in and check its status before starting an automation run.' : 'A run is already active', runId: queued.activeRun?._id || null });
      }
      req.portalSession.interactiveLeaseKey = null;
      return res.status(202).json({ ok: true, runId: queued.run._id, status: queued.run.status });
    } catch (error) {
      await restore();
      throw error;
    }
  }
  if (interactiveLeaseKey) {
    await releaseInteractiveBrowser(req.portalAccount.userId, interactiveLeaseKey);
    req.portalSession.interactiveLeaseKey = null;
  }
  runner.run({ discovery: false, apply: true, jobId: j.id, verificationCode: req.body.code }).catch(error => console.error(error.message));
  res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/reports', async (req, res, next) => {
 try {
  const dir = path.join(store.ROOT, 'reports');
  const local = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.replace('.json', '')) : [];
  const shared = (await require('./userFiles').listSharedFiles(req.portalAccount.userId, 'report')).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.replace('.json', ''));
  const days = [...new Set([...local, ...shared])].sort().reverse();
  res.json({ days });
 } catch (error) { next(error); }
});
app.get('/reports/:file', async (req, res, next) => {
 try {
  if (!/^(?:shortlist-)?\d{4}-\d{2}-\d{2}\.(json|csv|html)$/.test(req.params.file)) return res.sendStatus(400);
  if (req.params.file.endsWith('.csv')) res.attachment(req.params.file);
  const local = require('./userFiles').localPath('report', req.params.file);
  const file = await require('./userFiles').findSharedFile(req.portalAccount.userId, 'report', req.params.file);
  if (file) return res.type(file.contentType).send(file.buffer);
  if (fs.existsSync(local)) return res.sendFile(local);
  return res.sendStatus(404);
 } catch (error) { next(error); }
});
app.post('/api/run', async (req, res, next) => {
  try {
    const allowed = ['discover', 'apply', 'dry-run', 'daily'];
    if (!allowed.includes(req.body.mode)) return res.status(400).json({ error: 'Unknown run mode' });
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
      if (await accountBusy(req.portalAccount.userId)) return res.status(409).json({ error: 'Finish the active run or interactive browser session before starting another run.' });
      await userData.loadAutomationState(req.portalAccount.userId);
    }
    if (!hasRunnableProfile()) return res.status(400).json({ error: 'Upload a resume and save your candidate profile with at least one preferred city first' });
    if (req.body.jobId && !store.state().jobs.some(job => job.id === req.body.jobId)) return res.status(404).json({ error: 'Automation job not found in this account.' });
    if (await accountBusy(req.portalAccount.userId)) return res.status(409).json({ error: 'Finish the active run or interactive browser session before starting another run.' });
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true') {
      await connectQueueDb();
      const queued = await enqueueBrowserAutomation(req.portalAccount.userId, { mode: req.body.mode, jobId: req.body.jobId, targetWorkerId: automationInstanceId });
      if (!queued.accepted) return res.status(409).json({ error: queued.interactiveLeaseUntil ? 'Finish platform sign-in and check its status before starting an automation run.' : 'An automation run is already queued or running.', runId: queued.activeRun?._id || null });
      return res.status(202).json({ ok: true, message: 'Automation run queued.', runId: queued.run._id, status: queued.run.status });
    }
    if (isRunning()) return res.status(409).json({ error: 'A run is already active' });
    if (!runner.hasCapacity()) return res.status(429).json({ error: 'The automation worker is busy. Your run was not started; try again when an active run finishes.' });
    const mode = req.body.mode;
    runner.run({ discovery: ['discover', 'daily'].includes(mode), apply: mode !== 'discover', dryRun: mode === 'dry-run', jobId: req.body.jobId }).catch(e => console.error(e.message));
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.patch('/api/settings', (req, res) => {
  const { paused, autoApply, dailyTarget } = req.body;
  if (dailyTarget !== undefined && (!Number.isInteger(dailyTarget) || dailyTarget < 15 || dailyTarget > 100)) return res.status(400).json({ error: 'Daily target must be an integer between 15 and 100' });
  store.mutate(s => { if (typeof paused === 'boolean') s.settings.paused = paused; if (typeof autoApply === 'boolean') s.settings.autoApply = autoApply; if (dailyTarget !== undefined) s.settings.dailyTarget = dailyTarget; });
  res.json({ ok: true });
  if (req.portalAccount?.userId && process.env.AUTOMATION_QUEUE_ENABLED !== 'true') {
    userData.saveAutomationState(req.portalAccount.userId, store.state()).catch(() => {});
  }
});
app.post('/api/exclusions', (req, res) => {
  if (!Array.isArray(req.body.companies) || req.body.companies.some(c => typeof c !== 'string' || c.length > 100)) return res.status(400).json({ error: 'Provide company names' });
  store.mutate(s => { s.excludedCompanies = [...new Set(req.body.companies.map(c => c.trim()).filter(Boolean))]; for (const j of s.jobs) if (j.status === 'queued' && s.excludedCompanies.some(c => c.toLowerCase() === j.company.toLowerCase())) { j.status = 'excluded'; j.reason = 'Previously applied or excluded by you'; } });
  res.json({ ok: true });
});
app.post('/api/jobs/import', async (req, res, next) => {
  try { res.json({ ok: true, job: await importJob(req.body.url, runner.profile(), req.body.company) }); } catch (error) { next(error); }
});
// Questions waiting on the candidate, grouped so one answer unblocks every job that asks it.
app.get('/api/questions', (req, res) => {
  const groups = new Map();
  for (const j of store.state().jobs.filter(j => j.status === 'needs_input')) {
    // Skip questions the worker can now answer on its own.
    for (const q of (j.questions || []).filter(q => q.type !== 'file' && q.label && !require('./answers').resolve(q, runner.profile(), store.state().answers, q.origin, j)?.value)) {
      const key = normalize(q.label);
      const g = groups.get(key) || { key, label: q.label.replace(/\s+/g, ' ').trim(), type: q.type, required: false, options: [], jobs: [] };
      g.required ||= !!q.required;
      for (const o of q.options || []) if (o.label && !g.options.includes(o.label.trim())) g.options.push(o.label.trim());
      if (!g.jobs.some(x => x.id === j.id)) g.jobs.push({ id: j.id, company: j.company, title: j.title, applyLink: j.applyLink, source: j.source });
      groups.set(key, g);
    }
  }
  const blocked = store.state().jobs.filter(j => j.status === 'needs_input' && j.ats !== 'linkedin_manual' && !(j.questions || []).some(q => q.type !== 'file' && q.label))
    .map(j => ({ id: j.id, company: j.company, title: j.title, applyLink: j.applyLink, source: j.source, reason: j.reason }));
  res.json({ questions: [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length), blocked });
});
// LinkedIn-only jobs from alert emails: you apply on LinkedIn yourself, then mark them here.
app.get('/api/linkedin', (req, res) => {
  const { ageDays } = require('./matching');
  const jobs = store.state().jobs.filter(j => j.ats === 'linkedin_manual');
  const pick = j => ({ id: j.id, company: j.company, title: j.title, location: j.location, applyLink: j.applyLink, ageDays: ageDays(j), submittedAt: j.submittedAt || null });
  res.json({ waiting: jobs.filter(j => j.status === 'needs_input').map(pick).sort((a, b) => (a.ageDays ?? 99) - (b.ageDays ?? 99)), applied: jobs.filter(j => j.status === 'submitted').map(pick) });
});
app.post('/api/linkedin/:id', (req, res) => {
  const job = store.state().jobs.find(j => j.id === req.params.id && j.ats === 'linkedin_manual' && j.status === 'needs_input');
  if (!job || !['applied', 'skip'].includes(req.body.action)) return res.status(400).json({ error: 'Unknown LinkedIn job or action' });
  store.mutate(s => {
    const j = s.jobs.find(j => j.id === req.params.id);
    if (req.body.action === 'applied') { j.status = 'submitted'; j.submittedAt = new Date().toISOString(); j.completionMethod = 'You applied on LinkedIn'; j.confirmation = { text: 'Marked applied on the dashboard', source: 'Confirmed by candidate', at: j.submittedAt }; j.reason = ''; }
    else { j.status = 'archived'; j.reason = 'Not interested (your choice)'; }
  });
  res.json({ ok: true });
});
app.post('/api/questions/answer', (req, res) => {
  const { key, value } = req.body;
  if (typeof key !== 'string' || typeof value !== 'string' || !value.trim() || value.length > 5000) return res.status(400).json({ error: 'Provide an answer' });
  let requeued = 0;
  store.mutate(s => {
    s.answers[`*|*|${key}`] = value.trim();
    for (const j of s.jobs.filter(j => j.status === 'needs_input' && (j.questions || []).some(q => normalize(q.label) === key))) {
      j.questions = j.questions.filter(q => normalize(q.label) !== key);
      if (!j.questions.some(q => q.type !== 'file')) { j.status = evaluate(j, runner.profile()).eligible ? 'queued' : 'excluded'; j.reason = 'Your answers are saved; will retry'; requeued++; }
    }
  });
  res.json({ ok: true, requeued });
});
app.post('/api/jobs/:id/archive', (req, res) => {
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); if (j && j.status === 'needs_input') { j.status = 'archived'; j.reason = 'Archived by you'; } });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/answers', (req, res) => {
  const s = store.state(), job = s.jobs.find(j => j.id === req.params.id);
  if (!job || job.status !== 'needs_input') return res.status(400).json({ error: 'Select an application that needs answers' });
  const answers = req.body.answers;
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Provide answers' });
  for (const a of answers) {
    if (typeof a.label !== 'string' || typeof a.value !== 'string' || a.value.length > 5000 || !job.questions?.some(q => q.label === a.label && q.origin === a.origin && q.type !== 'file')) return res.status(400).json({ error: 'Answer does not belong to this application' });
  }
  store.mutate(value => {
    for (const a of answers) value.answers[`${job.company}|${a.origin}|${normalize(a.label)}`] = a.value;
    const j = value.jobs.find(j => j.id === job.id);
    j.status = evaluate(j, runner.profile()).eligible ? 'queued' : 'excluded'; j.questions = []; j.reason = '';
  });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/open', async (req, res, next) => {
  const userId = req.portalAccount.userId;
  let reserved = false;
  try {
    if (await accountBusy(userId)) return res.status(409).json({ error: 'Finish the active run or interactive browser session before opening another browser task.' });
    const job = store.state().jobs.find(j => j.id === req.params.id);
    if (!job) return res.sendStatus(404);
    const leaseKey = browserLeaseKey(req);
    const lease = await reserveInteractiveBrowser(userId, leaseKey);
    if (!lease) return res.status(409).json({ error: 'An automation run started first. Wait for it to finish before opening the browser.' });
    reserved = true;
    await browser.open(job.applyLink, { interactive: true });
    res.json({ ok: true, leaseExpiresAt: lease.toISOString() });
  } catch (error) {
    if (reserved) await releaseInteractiveBrowser(userId, req.portalSession.interactiveLeaseKey).catch(() => {});
    next(error);
  }
});
app.post('/api/jobs/:id/finish', async (req, res, next) => {
  const userId = req.portalAccount.userId;
  let reserved = false;
  let keepLease = false;
  try {
    if (await accountBusy(userId, { allowInteractive: true })) return res.status(409).json({ error: 'Wait for the current run to finish before manual verification' });
    const lease = await reserveInteractiveBrowser(userId, browserLeaseKey(req));
    if (!lease) return res.status(409).json({ error: 'An automation run started first. Wait for it to finish before manual verification.' });
    reserved = true;
    const s = store.state(), job = s.jobs.find(j => j.id === req.params.id);
    if (!job || !['needs_input', 'submission_uncertain', 'queued', 'ready'].includes(job.status)) return res.status(400).json({ error: 'Select an unfinished application' });
    const p = runner.profile();
    const match = evaluate(job, { ...p, excludedCompanies: [...p.excludedCompanies, ...s.excludedCompanies] });
    if (!match.eligible) return res.status(400).json({ error: match.blocked.join('; ') });
    const result = await browser.apply(job, p, s.answers, { dryRun: true, interactive: true });
    if (job.ats === 'workday') await browser.open(job.applyLink, { interactive: true });
    keepLease = true;
    res.json({ ok: true, leaseExpiresAt: lease.toISOString(), message: 'Finish the application and verification in the window you opened. Record confirmation afterward.', questions: result.questions || [] });
  } catch (error) { next(error); }
  finally { if (reserved && !keepLease) await releaseInteractiveBrowser(userId, req.portalSession.interactiveLeaseKey).catch(() => {}); }
});
app.post('/api/platforms/:name/open', async (req, res, next) => {
  const userId = req.portalAccount.userId;
  let reserved = false;
  try {
    if (await accountBusy(userId)) return res.status(409).json({ error: 'Finish the active run or interactive browser session before opening another browser task.' });
    const platform = PLATFORMS.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (!platform) return res.sendStatus(404);
    if (!platform.url) return res.status(400).json({ error: 'The exact website URL must be confirmed first' });
    const leaseKey = browserLeaseKey(req);
    const lease = await reserveInteractiveBrowser(userId, leaseKey);
    if (!lease) return res.status(409).json({ error: 'An automation run started first. Wait for it to finish before signing in.' });
    reserved = true;
    await browser.open(platform.url, { interactive: true });
    res.json({ ok: true, leaseExpiresAt: lease.toISOString() });
  } catch (error) {
    if (reserved) await releaseInteractiveBrowser(userId, req.portalSession.interactiveLeaseKey).catch(() => {});
    next(error);
  }
});
app.post('/api/platforms/:name/check', async (req, res, next) => {
  const userId = req.portalAccount.userId;
  let reserved = false;
  try {
    if (await accountBusy(userId, { allowInteractive: true })) return res.status(409).json({ error: 'Wait for the active run to finish before checking platform sign-in' });
    const platform = PLATFORMS.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (!platform) return res.sendStatus(404);
    const leaseKey = browserLeaseKey(req);
    const lease = await reserveInteractiveBrowser(userId, leaseKey);
    if (!lease) return res.status(409).json({ error: 'An automation run started first. Wait for it to finish before checking sign-in.' });
    reserved = true;
    const statuses = await require('./platforms').inspect(platform.name);
    res.json({ platform: statuses.find(item => item.name === platform.name) });
  } catch (error) { next(error); }
  finally {
    if (reserved) {
      await releaseInteractiveBrowser(userId, req.portalSession.interactiveLeaseKey).catch(error => console.error('Could not release interactive browser lease:', error.message));
      req.portalSession.interactiveLeaseKey = null;
    }
  }
});
app.patch('/api/jobs/:id/outcome', (req, res) => {
  const allowed = ['recruiter_call', 'screening', 'interview', 'offer', 'rejected'];
  if (!allowed.includes(req.body.outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  const found = store.state().jobs.find(j => j.id === req.params.id);
  if (!found) return res.sendStatus(404);
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.outcome = req.body.outcome; j.outcomeAt = new Date().toISOString(); if (typeof req.body.notes === 'string') j.notes = req.body.notes.slice(0, 5000); if (typeof req.body.contact === 'string') j.contact = req.body.contact.slice(0, 300); });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/reconcile', async (req, res, next) => {
  const userId = req.portalAccount.userId;
  try {
  const job = store.state().jobs.find(j => j.id === req.params.id);
  if (!job || !['submission_uncertain', 'needs_input'].includes(job.status)) return res.status(400).json({ error: 'This application does not need reconciliation' });
  if (req.body.submitted !== true || typeof req.body.evidence !== 'string' || req.body.evidence.trim().length < 10) return res.status(400).json({ error: 'Record the actual confirmation or application reference' });
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.status = 'submitted'; j.submittedAt = new Date().toISOString(); j.confirmation = { text: req.body.evidence.trim(), source: 'Confirmed by candidate', at: j.submittedAt }; });
  await releaseInteractiveBrowser(userId, req.portalSession.interactiveLeaseKey);
  req.portalSession.interactiveLeaseKey = null;
  res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/evidence/:name', async (req, res, next) => {
  if (!/^[a-z0-9-]+\.png$/i.test(req.params.name)) return res.sendStatus(400);
  try {
    const local = require('./userFiles').localPath('evidence', req.params.name);
    const file = await require('./userFiles').findSharedFile(req.portalAccount.userId, 'evidence', req.params.name);
    if (file) return res.type('image/png').send(file.buffer);
    if (fs.existsSync(local)) return res.sendFile(local);
    return res.sendStatus(404);
  } catch (error) { next(error); }
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status) || 400;
  if (status >= 500) console.error('Automation request failed:', error.message);
  res.status(status).json({ error: status >= 500 ? 'Automation request failed.' : error.message });
});
function withAccountScope(userId, callback) { return userId ? store.runAsUser(userId, callback) : callback(); }
function accountScopes() { const users = store.listUserIds(); return users.length ? users : [null]; }
async function dispatchDailyForAccount(userId, force = false) {
  return withAccountScope(userId, async () => {
    const state = store.state();
    if (!hasRunnableProfile()) return false;
    if (!force && (state.settings.paused || await accountBusy(userId) || (state.settings.pausedUntil && Date.now() < Date.parse(state.settings.pausedUntil)))) return false;
    if (force && await accountBusy(userId)) return false;
    if (process.env.AUTOMATION_QUEUE_ENABLED === 'true' && userId) {
      await connectQueueDb();
      const queued = await enqueueBrowserAutomation(userId, { mode: 'daily', targetWorkerId: automationInstanceId });
      if (queued.accepted) store.event('Scheduled daily automation run queued');
      return queued.accepted;
    }
    await runner.run();
    return true;
  });
}
async function dispatchDailyForAll(force = false) {
  for (const userId of accountScopes()) {
    try { await dispatchDailyForAccount(userId, force); }
    catch (error) { console.error(`Scheduled automation run failed${userId ? ` for account ${userId}` : ''}:`, error.message); }
  }
}
function start() {
  if (process.env.AUTOMATION_QUEUE_ENABLED === 'true' && !process.env.MONGODB_URI) throw new Error('MONGODB_URI is required when AUTOMATION_QUEUE_ENABLED=true.');
  if (process.env.AUTOMATION_QUEUE_ENABLED === 'true' && !require('./secrets').isConfigured()) throw new Error('AUTOMATION_CREDENTIAL_KEY (at least 32 bytes) is required when the durable automation queue is enabled.');
  try { require('node:os').setPriority(process.pid, 10); } catch { /* best effort on supported platforms */ }
  const queueWorker = process.env.AUTOMATION_QUEUE_ENABLED === 'true'
    ? require('../../scripts/automation-worker.cjs')
    : null;
  if (queueWorker) queueWorker.start({ types: ['job-hunt', 'browser-automation'], workerId: automationInstanceId }).catch(error => console.error('Automation queue worker stopped:', error.message));
  // Note: do NOT call app.listen() here; the main app will listen on its own port.
  // If start() is called directly (e.g. `node src/automation/server.js`), it will listen on PORT.
  if (require.main === module) {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`Naukri Khojo daily applications: http://127.0.0.1:${PORT}`);
      console.log('Schedule: 8:00 AM IST. Keep this worker running and your Mac awake.');
      console.log('Applications run silently in a headless browser. Interactive windows open only on your explicit dashboard action.');
      if (process.argv.includes('--run-today')) dispatchDailyForAll(true).catch(e => console.error(e.message));
    });
  }
  // Track employer replies every 30 minutes while the worker is up.
  cron.schedule('*/30 * * * *', async () => {
    for (const userId of accountScopes()) await withAccountScope(userId, async () => {
      if (require('./email').status().connected) await require('./inbox').scan().catch(e => console.error(e.message));
    });
  });
  // LinkedIn job-alert emails become employer-site applications (or a by-hand list) without touching LinkedIn.
  cron.schedule('10,40 * * * *', async () => {
    for (const userId of accountScopes()) await withAccountScope(userId, async () => {
      const p = store.read('profile', null);
      if (p && require('./email').status().connected) await require('./linkedinAlerts').scan(p).catch(e => console.error(e.message));
    });
  });
  // Quiet-hours runs pick up Naukri, which cannot run headless.
  // "Leave it for today": scheduled runs wait until pausedUntil; a dashboard click still runs at once.
  for (const at of ['5 21 * * *', '15 22 * * *', '30 23 * * *', '15 0 * * *', '15 1 * * *', '15 2 * * *']) cron.schedule(at, () => dispatchDailyForAll().catch(e => console.error(e.message)), { timezone: 'Asia/Kolkata' });
  // Missed runs (Mac asleep at the scheduled minute) are caught up as soon as the worker is awake again:
  // inside the quiet hours if nothing ran in the last 50 minutes, and during the day if nothing ran since 8 AM.
  const catchUp = async () => {
    for (const userId of accountScopes()) await withAccountScope(userId, async () => {
      const s = store.state();
      if (!hasRunnableProfile() || s.settings.paused || isRunning() || (s.settings.pausedUntil && Date.now() < Date.parse(s.settings.pausedUntil))) return;
      const last = Date.parse(s.runs?.[0]?.startedAt || 0) || 0;
      const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })) % 24;
      const today8 = Date.parse(`${store.indiaDay()}T08:00:00+05:30`);
      const due = require('./browser').quietHours(s.settings) ? Date.now() - last > 50 * 60000 : hour >= 8 && hour < 21 && last < today8;
      if (due) {
        store.event('Catching up a missed scheduled run');
        await dispatchDailyForAccount(userId);
      }
    });
  };
  cron.schedule('*/15 * * * *', catchUp);
  setTimeout(catchUp, 60000);
  // Keep macOS awake while the worker is up; other operating systems manage sleep separately.
  if (process.platform === 'darwin') {
    try { require('node:child_process').spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).unref(); } catch {}
  }
  cron.schedule('0 8 * * *', () => dispatchDailyForAll().catch(e => console.error(e.message)), { timezone: 'Asia/Kolkata' });
  async function stop() {
    if (queueWorker) await queueWorker.stop().catch(() => {});
    await browser.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
// One failed background task (mail, browser) must not take the scheduler down; log it and keep running.
// This process-level hook has no reliable account context; keep the diagnostic
// in process logs rather than writing one account's error into another account's event file.
process.on('uncaughtException', error => { console.error('Uncaught:', error.message); });
process.on('unhandledRejection', error => { console.error('Unhandled:', error?.message || error); });
if (require.main === module) start();
module.exports = { app, start };
