require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
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
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const coldAttachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
function isRunning() { return runner.isRunning() || store.workerActive(); }
const PORT = Number(process.env.AUTOMATION_PORT || 4129);
const token = crypto.randomBytes(32).toString('hex');
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
app.use((req, res, next) => { if (!['GET', 'HEAD'].includes(req.method)) res.on('finish', () => { try { require('./reports').save(); } catch (e) { console.error('Report save failed:', e.message); } }); next(); });
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/automation.html'), 'utf8').replace('__LOCAL_TOKEN__', token);
  res.type('html').send(html);
});
app.get('/api/state', (req, res) => {
  const s = store.state(), p = store.read('profile', null);
  // Job descriptions are most of the state file (80+ MB); the dashboard fetches one only when you open it.
  const slim = ({ description, attempts, match, ...j }) => ({ ...j, hasDescription: !!description, match: match && { score: match.score, eligible: match.eligible, blocked: match.blocked, reasons: match.reasons, salaryStatus: match.salaryStatus } });
  res.json({ ...s, jobs: s.jobs.map(slim), profile: p, companies: COMPANIES, companyStatus: store.read('companies-status', []), platforms: PLATFORMS, platformStatus: store.read('platform-status', []), running: isRunning(), day: store.indiaDay(), confirmedToday: runner.todays(s).length });
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
    if (isRunning()) return res.status(409).json({ error: 'Wait for the current run to finish before updating your profile' });
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
      const resumePath = path.join(store.ROOT, filename);
      fs.writeFileSync(resumePath, req.file.buffer, { mode: 0o600, flag: 'wx' });
    } else if (!filename || !fs.existsSync(path.join(store.ROOT, filename))) {
      return res.status(400).json({ error: 'Upload a PDF or DOCX resume before saving this profile' });
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
    store.write('profile', updated);
    store.mutate(s => { s.settings.paused = true; s.settings.autoApply = false; });
    store.event('Candidate profile updated from a reviewed resume and profile form');
    res.json({ ok: true, profile: updated });
  } catch (error) { next(error); }
});
app.get('/api/jobs/:id/description', (req, res) => { const j = store.state().jobs.find(j => j.id === req.params.id); if (!j) return res.sendStatus(404); res.json({ description: j.description || '' }); });
app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'local-automation', running: isRunning(), browserMode: 'headless', browserActive: browser.isBackground() }));
app.get('/api/email/status', (req, res) => res.json(require('./email').status()));
app.get('/api/inbox', (req, res) => res.json(require('./inbox').summary()));
app.post('/api/inbox/scan', async (req, res, next) => { try { await require('./inbox').scan(); res.json(require('./inbox').summary()); } catch (e) { next(e); } });
app.get('/api/shortlist', (req, res) => res.json(require('./shortlist').build()));
app.post('/api/email/connect', async (req, res, next) => {
  try { res.json(await require('./email').connect(req.body.email, req.body.appPassword, runner.profile().email)); } catch (error) { next(error); }
});
app.post('/api/cold-email/extract', coldAttachmentUpload.single('sheet'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an XLSX or CSV sheet first.' });
    res.json(await require('./coldEmail').extractContacts(req.file.buffer, req.file.originalname));
  } catch (error) { next(error); }
});
app.get('/api/cold-email/contacts', (req, res, next) => {
  try { res.json(require('./coldEmail').listContacts({ query: req.query.query, company: req.query.company, status: req.query.status, page: req.query.page, limit: req.query.limit })); }
  catch (error) { next(error); }
});
app.post('/api/cold-email/contacts/import', (req, res, next) => {
  try { res.json({ ok: true, ...require('./coldEmail').importContacts(req.body.contacts, req.body.sourceFile, req.body.duplicateCount) }); }
  catch (error) { next(error); }
});
app.patch('/api/cold-email/contacts/:id', (req, res, next) => {
  try { const contact = require('./coldEmail').updateContact(req.params.id, req.body); if (!contact) return res.sendStatus(404); res.json({ ok: true, contact }); }
  catch (error) { next(error); }
});
app.delete('/api/cold-email/contacts/:id', (req, res, next) => {
  try { if (!require('./coldEmail').deleteContact(req.params.id)) return res.sendStatus(404); res.json({ ok: true }); }
  catch (error) { next(error); }
});
app.post('/api/cold-email/send', coldAttachmentUpload.single('attachment'), async (req, res, next) => {
  try {
    const contactIds = JSON.parse(req.body.contactIds || 'null');
    const started = await require('./coldEmail').startCampaign({ contactIds, subject: req.body.subject, text: req.body.text, attachment: req.file, attested: req.body.attested === 'true' });
    res.status(202).json(started);
  } catch (error) { next(error); }
});
app.get('/api/cold-email/status/:id', (req, res) => {
  const coldEmail = require('./coldEmail'); coldEmail.cleanup();
  const result = coldEmail.status(req.params.id);
  if (!result) return res.sendStatus(404);
  res.json(result);
});
app.post('/api/jobs/:id/verify', (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already active' });
  if (!/^[A-Za-z0-9]{8}$/.test(req.body.code || '')) return res.status(400).json({ error: 'Enter the 8-character email security code' });
  const s = store.state(), j = s.jobs.find(j => j.id === req.params.id);
  if (!j || !['needs_input', 'submission_uncertain'].includes(j.status)) return res.status(400).json({ error: 'Select the application waiting for verification' });
  if (!evaluate(j, runner.profile()).eligible) return res.status(400).json({ error: 'This job is outside your confirmed preferences' });
  store.mutate(value => { const job = value.jobs.find(job => job.id === j.id); job.status = 'queued'; job.reason = 'Candidate supplied a one-time email verification code'; });
  runner.run({ discovery: false, apply: true, jobId: j.id, verificationCode: req.body.code }).catch(error => console.error(error.message));
  res.json({ ok: true });
});
app.get('/api/reports', (req, res) => {
  const dir = path.join(store.ROOT, 'reports');
  const days = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.replace('.json', '')).sort().reverse() : [];
  res.json({ days });
});
app.get('/reports/:file', (req, res) => {
  if (!/^(?:shortlist-)?\d{4}-\d{2}-\d{2}\.(json|csv|html)$/.test(req.params.file)) return res.sendStatus(400);
  if (req.params.file.endsWith('.csv')) res.attachment(req.params.file);
  res.sendFile(path.join(store.ROOT, 'reports', req.params.file));
});
app.post('/api/run', (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already active' });
  if (!store.read('profile', null)) return res.status(400).json({ error: 'Upload a resume and save your candidate profile first' });
  const allowed = ['discover', 'apply', 'dry-run', 'daily'];
  if (!allowed.includes(req.body.mode)) return res.status(400).json({ error: 'Unknown run mode' });
  const mode = req.body.mode;
  runner.run({ discovery: ['discover', 'daily'].includes(mode), apply: mode !== 'discover', dryRun: mode === 'dry-run', jobId: req.body.jobId }).catch(e => console.error(e.message));
  res.json({ ok: true });
});
app.patch('/api/settings', (req, res) => {
  const { paused, autoApply, dailyTarget } = req.body;
  if (dailyTarget !== undefined && (!Number.isInteger(dailyTarget) || dailyTarget < 15 || dailyTarget > 100)) return res.status(400).json({ error: 'Daily target must be an integer between 15 and 100' });
  store.mutate(s => { if (typeof paused === 'boolean') s.settings.paused = paused; if (typeof autoApply === 'boolean') s.settings.autoApply = autoApply; if (dailyTarget !== undefined) s.settings.dailyTarget = dailyTarget; });
  res.json({ ok: true });
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
  try { if (isRunning()) return res.status(409).json({ error: 'Pause and wait for the current application to finish before opening an interactive browser' }); const job = store.state().jobs.find(j => j.id === req.params.id); if (!job) return res.sendStatus(404); await browser.open(job.applyLink, { interactive: true }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/jobs/:id/finish', async (req, res, next) => {
  try {
    if (isRunning()) return res.status(409).json({ error: 'Wait for the current run to finish before manual verification' });
    const s = store.state(), job = s.jobs.find(j => j.id === req.params.id);
    if (!job || !['needs_input', 'submission_uncertain', 'queued', 'ready'].includes(job.status)) return res.status(400).json({ error: 'Select an unfinished application' });
    const p = runner.profile();
    const match = evaluate(job, { ...p, excludedCompanies: [...p.excludedCompanies, ...s.excludedCompanies] });
    if (!match.eligible) return res.status(400).json({ error: match.blocked.join('; ') });
    const result = await browser.apply(job, p, s.answers, { dryRun: true, interactive: true });
    if (job.ats === 'workday') await browser.open(job.applyLink, { interactive: true });
    res.json({ ok: true, message: 'Finish the application and verification in the window you opened. Record confirmation afterward.', questions: result.questions || [] });
  } catch (error) { next(error); }
});
app.post('/api/platforms/:name/open', async (req, res, next) => {
  try { if (isRunning()) return res.status(409).json({ error: 'Wait for the active run to finish before signing in' }); const platform = PLATFORMS.find(p => p.name.toLowerCase() === req.params.name.toLowerCase()); if (!platform) return res.sendStatus(404); if (!platform.url) return res.status(400).json({ error: 'The exact website URL must be confirmed first' }); await browser.open(platform.url, { interactive: true }); res.json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/platforms/:name/check', async (req, res, next) => {
  try {
    if (isRunning()) return res.status(409).json({ error: 'Wait for the active run to finish before checking platform sign-in' });
    const platform = PLATFORMS.find(p => p.name.toLowerCase() === req.params.name.toLowerCase());
    if (!platform) return res.sendStatus(404);
    const statuses = await require('./platforms').inspect(platform.name);
    res.json({ platform: statuses.find(item => item.name === platform.name) });
  } catch (error) { next(error); }
});
app.patch('/api/jobs/:id/outcome', (req, res) => {
  const allowed = ['recruiter_call', 'screening', 'interview', 'offer', 'rejected'];
  if (!allowed.includes(req.body.outcome)) return res.status(400).json({ error: 'Unknown outcome' });
  const found = store.state().jobs.find(j => j.id === req.params.id);
  if (!found) return res.sendStatus(404);
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.outcome = req.body.outcome; j.outcomeAt = new Date().toISOString(); if (typeof req.body.notes === 'string') j.notes = req.body.notes.slice(0, 5000); if (typeof req.body.contact === 'string') j.contact = req.body.contact.slice(0, 300); });
  res.json({ ok: true });
});
app.post('/api/jobs/:id/reconcile', (req, res) => {
  const job = store.state().jobs.find(j => j.id === req.params.id);
  if (!job || !['submission_uncertain', 'needs_input'].includes(job.status)) return res.status(400).json({ error: 'This application does not need reconciliation' });
  if (req.body.submitted !== true || typeof req.body.evidence !== 'string' || req.body.evidence.trim().length < 10) return res.status(400).json({ error: 'Record the actual confirmation or application reference' });
  store.mutate(s => { const j = s.jobs.find(j => j.id === req.params.id); j.status = 'submitted'; j.submittedAt = new Date().toISOString(); j.confirmation = { text: req.body.evidence.trim(), source: 'Confirmed by candidate', at: j.submittedAt }; });
  res.json({ ok: true });
});
app.get('/evidence/:name', (req, res) => {
  if (!/^[a-z0-9-]+\.png$/i.test(req.params.name)) return res.sendStatus(400);
  res.sendFile(path.join(store.ROOT, 'evidence', req.params.name));
});
app.use((error, req, res, next) => { console.error(error.message); res.status(400).json({ error: error.message }); });
function start() {
  try { require('node:os').setPriority(process.pid, 10); } catch { /* best effort on supported platforms */ }
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Naukri Khojo daily applications: http://127.0.0.1:${PORT}`);
    console.log('Schedule: 8:00 AM IST. Keep this worker running and your Mac awake.');
    console.log('Applications run silently in a headless browser. Interactive windows open only on your explicit dashboard action.');
    if (process.argv.includes('--run-today')) runner.run().catch(e => console.error(e.message));
  });
  // Track employer replies every 30 minutes while the worker is up.
  cron.schedule('*/30 * * * *', () => { if (require('./email').status().connected) require('./inbox').scan().catch(e => console.error(e.message)); });
  // LinkedIn job-alert emails become employer-site applications (or a by-hand list) without touching LinkedIn.
  cron.schedule('10,40 * * * *', () => { const p = store.read('profile', null); if (p && require('./email').status().connected) require('./linkedinAlerts').scan(p).catch(e => console.error(e.message)); });
  // Quiet-hours runs pick up Naukri, which cannot run headless.
  // "Leave it for today": scheduled runs wait until pausedUntil; a dashboard click still runs at once.
  const idle = s => !!store.read('profile', null) && !s.settings.paused && !isRunning() && !(s.settings.pausedUntil && Date.now() < Date.parse(s.settings.pausedUntil));
  for (const at of ['5 21 * * *', '15 22 * * *', '30 23 * * *', '15 0 * * *', '15 1 * * *', '15 2 * * *']) cron.schedule(at, () => { const s = store.state(); if (idle(s)) runner.run().catch(e => console.error(e.message)); }, { timezone: 'Asia/Kolkata' });
  // Missed runs (Mac asleep at the scheduled minute) are caught up as soon as the worker is awake again:
  // inside the quiet hours if nothing ran in the last 50 minutes, and during the day if nothing ran since 8 AM.
  const catchUp = () => {
    const s = store.state(); if (!idle(s)) return;
    const last = Date.parse(s.runs?.[0]?.startedAt || 0) || 0;
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false })) % 24;
    const today8 = Date.parse(`${store.indiaDay()}T08:00:00+05:30`);
    const due = require('./browser').quietHours(s.settings) ? Date.now() - last > 50 * 60000 : hour >= 8 && hour < 21 && last < today8;
    if (due) { store.event('Catching up a missed scheduled run'); runner.run().catch(e => console.error(e.message)); }
  };
  cron.schedule('*/15 * * * *', catchUp);
  setTimeout(catchUp, 60000);
  // Keep macOS awake while the worker is up; other operating systems manage sleep separately.
  if (process.platform === 'darwin') {
    try { require('node:child_process').spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }).unref(); } catch {}
  }
  cron.schedule('0 8 * * *', () => { const s = store.state(); if (idle(s)) runner.run().catch(e => console.error(e.message)); }, { timezone: 'Asia/Kolkata' });
  async function stop() { await browser.close().catch(() => {}); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
// One failed background task (mail, browser) must not take the scheduler down; log it and keep running.
process.on('uncaughtException', error => { console.error('Uncaught:', error.message); try { store.event(`Worker error (kept running): ${error.message.split('\n')[0].slice(0, 160)}`); } catch {} });
process.on('unhandledRejection', error => { console.error('Unhandled:', error?.message || error); });
if (require.main === module) start();
module.exports = { app, start };
