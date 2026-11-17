const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const store = require('./store');

const MAX_RECIPIENTS = 500;
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
const campaigns = new Map();
const activeCampaigns = new Map();
const MAX_CONTACTS = 50000;
const CAMPAIGN_LEASE_MS = 90_000;

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(cellText).join(' ');
    if (value.richText) return cellText(value.richText);
    if (value.text) return String(value.text);
    if (value.hyperlink) return String(value.hyperlink);
    if (value.result != null) return cellText(value.result);
    return '';
  }
  return String(value);
}

function emailsIn(value) {
  return [...cellText(value).matchAll(emailPattern)].map(match => match[0].replace(/[.,;:!?]+$/, '').trim()).filter(email => validEmail(email.toLowerCase()));
}

function headerKind(value) {
  const header = cellText(value).toLowerCase().replace(/[^a-z]/g, '');
  if (header.includes('email')) return 'email';
  if (/^(name|fullname|contact|contactname|personname)$/.test(header)) return 'name';
  if (/^(company|companyname|organization|organizationname|employer|employername)$/.test(header)) return 'company';
  return '';
}

function mergeCandidate(map, candidate) {
  const key = candidate.email.toLowerCase();
  const prior = map.get(key);
  if (!prior) { map.set(key, { ...candidate, emailNormalized: key, companies: candidate.company ? [candidate.company] : [], sourceRows: [candidate.sourceRow] }); return false; }
  if (candidate.name && !prior.name) prior.name = candidate.name;
  if (candidate.company && !prior.companies.some(company => company.toLowerCase() === candidate.company.toLowerCase())) prior.companies.push(candidate.company);
  if (prior.sourceRows.length < 20) prior.sourceRows.push(candidate.sourceRow);
  return true;
}

function parseSheet(sheet, sheetName, candidates, stats) {
  let headerRow = 0, columns = {};
  const rows = [];
  sheet.eachRow((row, rowNumber) => rows.push({ row, rowNumber }));
  for (const { row, rowNumber } of rows.slice(0, 10)) {
    const detected = {};
    row.eachCell((cell, column) => { const kind = headerKind(cell.value); if (kind === 'email') (detected.email ||= []).push(column); else if (kind && detected[kind] === undefined) detected[kind] = column; });
    if (detected.email?.length) { headerRow = rowNumber; columns = detected; break; }
  }
  for (const { row, rowNumber } of rows) {
    if (headerRow && rowNumber <= headerRow) continue;
    const values = new Map();
    row.eachCell((cell, column) => values.set(column, cell.value));
    const sourceRow = { sheet: sheetName, row: rowNumber };
    const emailValues = columns.email?.length ? columns.email.map(column => values.get(column)) : [...values.values()];
    for (const value of emailValues) {
      const found = emailsIn(value);
      if ((columns.email?.length ? !!cellText(value).trim() : cellText(value).includes('@')) && !found.length) stats.invalidCount++;
      for (const email of found) {
        if (mergeCandidate(candidates, {
          email: email.trim(),
          name: columns.name === undefined ? '' : cellText(values.get(columns.name)).trim().slice(0, 160),
          company: columns.company === undefined ? '' : cellText(values.get(columns.company)).trim().slice(0, 160),
          sourceRow,
        })) stats.duplicateCount++;
        if (candidates.size > MAX_RECIPIENTS) throw new Error(`The sheet contains more than ${MAX_RECIPIENTS} unique email addresses. Split it into smaller files.`);
      }
    }
  }
}

async function extractContacts(buffer, originalName) {
  const extension = path.extname(originalName || '').toLowerCase();
  const candidates = new Map(), stats = { duplicateCount: 0, invalidCount: 0 };
  if (extension === '.csv') {
    const workbook = new ExcelJS.Workbook();
    const sheet = await workbook.csv.read(Readable.from([buffer]));
    parseSheet(sheet, sheet.name || 'CSV', candidates, stats);
  } else if (extension === '.xlsx') {
    if (buffer.subarray(0, 2).toString() !== 'PK') throw new Error('This file is not a valid XLSX workbook.');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    if (workbook.worksheets.length > 20) throw new Error('The workbook has too many sheets. Limit it to 20 sheets.');
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > 10000) throw new Error(`Sheet "${sheet.name}" has more than 10,000 rows.`);
      parseSheet(sheet, sheet.name, candidates, stats);
    }
  } else {
    throw new Error('Choose an .xlsx or .csv file. Legacy .xls files are not supported; save them as .xlsx or .csv first.');
  }
  if (!candidates.size && !stats.invalidCount) throw new Error('No email addresses were found in this file.');
  if (candidates.size > MAX_RECIPIENTS) throw new Error(`The sheet contains more than ${MAX_RECIPIENTS} unique email addresses. Split it into smaller files.`);
  return { contacts: [...candidates.values()], duplicateCount: stats.duplicateCount, invalidCount: stats.invalidCount, count: candidates.size };
}

function safeSourceName(value) { return path.basename(String(value || '')).replace(/[\r\n"\\/]/g, '_').slice(0, 120); }
function readContacts() { const contacts = store.read('company-contacts', []); if (!Array.isArray(contacts)) throw new Error('Saved contacts data is invalid.'); return contacts; }
function listContacts({ query = '', company = '', status = 'active', page = 1, limit = 100 } = {}) {
  if (!['active', 'archived', 'all'].includes(status)) throw new Error('Choose active, archived, or all contacts.');
  const needle = String(query).trim().toLowerCase(), companyNeedle = String(company).trim().toLowerCase();
  const pageNumber = Math.max(1, Math.min(100000, Number(page) || 1)), pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
  const all = readContacts().filter(contact => (status === 'all' || contact.status === (status || 'active')) &&
    (!needle || [contact.email, contact.name, ...(contact.companies || [])].join(' ').toLowerCase().includes(needle)) &&
    (!companyNeedle || (contact.companies || []).some(item => item.toLowerCase() === companyNeedle))
  ).sort((a, b) => String(b.lastImportedAt).localeCompare(String(a.lastImportedAt)) || a.email.localeCompare(b.email));
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const currentPage = Math.min(pageNumber, pages);
  return { contacts: all.slice((currentPage - 1) * pageSize, currentPage * pageSize), total: all.length, page: currentPage, pages, companies: [...new Set(readContacts().flatMap(contact => contact.companies || []))].sort((a, b) => a.localeCompare(b)) };
}

function importContacts(input, sourceFile, sourceDuplicates = 0) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_RECIPIENTS) throw new Error(`Choose 1–${MAX_RECIPIENTS} contacts to import.`);
  const contacts = readContacts(), byEmail = new Map(contacts.map(contact => [contact.emailNormalized, contact]));
  const now = new Date().toISOString(), source = safeSourceName(sourceFile); let created = 0, updated = 0, duplicates = 0, invalid = 0;
  for (const item of input) {
    const email = String(item?.email || '').trim(), normalized = email.toLowerCase();
    if (!validEmail(normalized)) { invalid++; continue; }
    let contact = byEmail.get(normalized);
    if (!contact) {
      contact = { id: crypto.randomUUID(), email, emailNormalized: normalized, name: '', companies: [], sourceFiles: [], firstImportedAt: now, lastImportedAt: now, importCount: 0, status: 'active' };
      contacts.push(contact); byEmail.set(normalized, contact); created++;
    } else { updated++; }
    if (item.name && !contact.name) contact.name = String(item.name).trim().slice(0, 160);
    const companies = [...(Array.isArray(item.companies) ? item.companies.slice(0, 20) : []), item.company].filter(Boolean).slice(0, 20).map(value => String(value).trim().slice(0, 160)).filter(Boolean);
    for (const name of companies) if (!contact.companies.some(existing => existing.toLowerCase() === name.toLowerCase())) contact.companies.push(name);
    if (source && !contact.sourceFiles.includes(source) && contact.sourceFiles.length < 20) contact.sourceFiles.push(source);
    contact.lastImportedAt = now; contact.importCount = (contact.importCount || 0) + 1; contact.status = contact.status || 'active';
  }
  duplicates = Math.max(0, Math.min(10000, Number(sourceDuplicates) || 0));
  if (contacts.length > MAX_CONTACTS) throw new Error(`The saved address book is limited to ${MAX_CONTACTS} contacts.`);
  store.write('company-contacts', contacts);
  return { created, updated, duplicates, invalid, total: contacts.length };
}

function updateContact(id, changes = {}) {
  const contacts = readContacts(), contact = contacts.find(item => item.id === id);
  if (!contact) return null;
  if (changes.name !== undefined) contact.name = String(changes.name || '').trim().slice(0, 160);
  if (changes.companies !== undefined) {
    if (!Array.isArray(changes.companies)) throw new Error('Companies must be a list.');
    contact.companies = [...new Set(changes.companies.map(value => String(value).trim().slice(0, 160)).filter(Boolean))];
  }
  if (changes.status !== undefined) {
    if (!['active', 'archived'].includes(changes.status)) throw new Error('Contact status must be active or archived.');
    contact.status = changes.status;
  }
  contact.updatedAt = new Date().toISOString();
  store.write('company-contacts', contacts);
  return contact;
}

function deleteContact(id) {
  const contacts = readContacts(), next = contacts.filter(contact => contact.id !== id);
  if (next.length === contacts.length) return false;
  store.write('company-contacts', next); return true;
}

function cleanFilename(name) {
  return path.basename(String(name || 'attachment')).replace(/[\r\n"\\/]/g, '_').slice(0, 120) || 'attachment';
}

function publicCampaign(campaign) {
  if (!campaign) return null;
  const { attachment, ownerKey, userId, leaseToken, _id, __v, ...safe } = campaign;
  return safe;
}

async function status(id) {
  const userId = store.currentUserId();
  if (process.env.MONGODB_URI && userId) {
    const { connectQueueDb } = require('../automationQueue');
    const { AutomationCampaign } = require('../models');
    await connectQueueDb();
    await recoverStaleCampaigns(userId);
    const saved = await AutomationCampaign.findOne({ userId, campaignId: id }).lean();
    if (saved) return publicCampaign(saved);
  }
  const campaign = campaigns.get(id);
  if (!campaign || campaign.ownerKey !== store.ROOT || (campaign.userId && campaign.userId !== userId)) return null;
  return publicCampaign(campaign);
}

async function recoverStaleCampaigns(userId = null) {
  if (!process.env.MONGODB_URI) return 0;
  const { connectQueueDb } = require('../automationQueue');
  const { AutomationCampaign } = require('../models');
  await connectQueueDb();
  const filter = {
    status: 'sending',
    $or: [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }],
  };
  if (userId) filter.userId = userId;
  const result = await AutomationCampaign.updateMany(filter, {
    $set: {
      status: 'interrupted',
      finishedAt: new Date(),
      error: 'Sending stopped before the campaign completed. Some recipient outcomes may be uncertain; review results before retrying.',
      leaseUntil: null,
    },
  });
  return result.modifiedCount || 0;
}

async function startCampaign({ contactIds, subject, text, attachment, attested }) {
  const ownerKey = store.ROOT;
  const userId = store.currentUserId();
  if (activeCampaigns.has(ownerKey)) throw new Error('A cold email campaign is already processing for this account. Wait for it to finish.');
  if (attested !== true) throw new Error('Confirm that you reviewed the recipient list and are authorized to contact these people.');
  const connection = require('./email').credentials();
  if (!connection?.email || !connection?.appPassword) throw new Error('Connect and verify Gmail in Accounts & import before sending.');
  const profile = store.read('profile', null);
  if (!profile?.email || connection.email.toLowerCase() !== profile.email.toLowerCase()) throw new Error('The saved Gmail account does not match the current profile email. Reconnect Gmail before sending.');
  if (!Array.isArray(contactIds) || !contactIds.length || contactIds.length > MAX_RECIPIENTS) throw new Error(`Choose between 1 and ${MAX_RECIPIENTS} saved contacts.`);
  const contacts = readContacts(), byId = new Map(contacts.filter(contact => contact.status === 'active').map(contact => [contact.id, contact]));
  const unique = [...new Map(contactIds.map(id => byId.get(String(id))).filter(Boolean).map(contact => [contact.emailNormalized, contact])).values()];
  if (unique.length !== new Set(contactIds).size) throw new Error('One or more selected contacts are missing or archived. Refresh the address book and try again.');
  subject = String(subject || '').trim();
  text = String(text || '').trim();
  if (!subject || subject.length > 200) throw new Error('Enter a subject of 1–200 characters.');
  if (!text || text.length > 50000) throw new Error('Enter an email body of 1–50,000 characters.');

  const id = crypto.randomUUID();
  const leaseToken = crypto.randomBytes(32).toString('hex');
  const campaign = { id, campaignId: id, userId, ownerKey, leaseToken, status: 'sending', total: unique.length, sent: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, results: [], error: null };
  let durableCampaign = false;
  if (process.env.MONGODB_URI && userId) {
    const { connectQueueDb } = require('../automationQueue');
    const { AutomationCampaign } = require('../models');
    await connectQueueDb();
    await recoverStaleCampaigns(userId);
    try {
      await AutomationCampaign.create({ userId, campaignId: id, status: campaign.status, total: campaign.total, startedAt: campaign.startedAt, leaseUntil: new Date(Date.now() + CAMPAIGN_LEASE_MS), leaseToken });
      durableCampaign = true;
    } catch (error) {
      if (error.code === 11000) throw new Error('A cold email campaign is already processing for this account. Wait for it to finish.');
      throw error;
    }
  }
  campaigns.set(id, campaign);
  activeCampaigns.set(ownerKey, id);
  const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: connection.email, pass: connection.appPassword }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });

  void (async () => {
    let leaseLost = false;
    try {
      await transporter.verify();
      for (const contact of unique) {
        if (durableCampaign) {
          try {
            const owned = await require('../models').AutomationCampaign.updateOne(
              { userId, campaignId: id, status: 'sending', leaseToken, leaseUntil: { $gt: new Date() } },
              { $set: { leaseUntil: new Date(Date.now() + CAMPAIGN_LEASE_MS) } }
            );
            if (!owned.matchedCount) {
              leaseLost = true;
              campaign.status = 'interrupted';
              campaign.error = 'Campaign ownership expired; no further recipients were sent.';
              break;
            }
          } catch (error) {
            console.error('Could not confirm cold email campaign ownership:', error.message);
            leaseLost = true;
            campaign.status = 'interrupted';
            campaign.error = 'Campaign ownership could not be confirmed; no further recipients were sent.';
            break;
          }
        }
        try {
          await transporter.sendMail({
            from: connection.email,
            to: contact.email,
            subject,
            text,
            ...(attachment ? { attachments: [{ filename: cleanFilename(attachment.originalname), content: attachment.buffer }] } : {}),
          });
          campaign.sent++;
          campaign.results.push({ contactId: contact.id, name: contact.name || '', email: contact.email, company: (contact.companies || []).join(', '), status: 'sent' });
        } catch {
          campaign.failed++;
          campaign.results.push({ contactId: contact.id, name: contact.name || '', email: contact.email, company: (contact.companies || []).join(', '), status: 'failed', error: 'Message could not be sent.' });
        }
        if (durableCampaign) {
          try {
            const persisted = await require('../models').AutomationCampaign.updateOne(
              { userId, campaignId: id, status: 'sending', leaseToken, leaseUntil: { $gt: new Date() } },
              { $set: { sent: campaign.sent, failed: campaign.failed, results: campaign.results, leaseUntil: new Date(Date.now() + CAMPAIGN_LEASE_MS) } }
            );
            if (!persisted.matchedCount) {
              leaseLost = true;
              campaign.status = 'interrupted';
              campaign.error = 'Campaign ownership expired after a recipient attempt; review its outcome before retrying.';
              break;
            }
          } catch (error) {
            console.error('Could not persist cold email campaign progress:', error.message);
            leaseLost = true;
            campaign.status = 'interrupted';
            campaign.error = 'Campaign progress could not be saved; review recipient outcomes before retrying.';
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!leaseLost) campaign.status = campaign.failed ? 'completed_with_errors' : 'completed';
    } catch {
      campaign.status = 'failed';
      campaign.error = 'Could not connect to Gmail SMTP. Verify the saved app password and try again.';
    } finally {
      if (!leaseLost) campaign.finishedAt = new Date().toISOString();
      campaign.attachment = undefined;
      transporter.close();
      if (durableCampaign && !leaseLost) {
        try {
          const completed = await require('../models').AutomationCampaign.updateOne(
            { userId, campaignId: id, status: 'sending', leaseToken, leaseUntil: { $gt: new Date() } },
            { $set: { status: campaign.status, sent: campaign.sent, failed: campaign.failed, results: campaign.results, error: campaign.error, finishedAt: campaign.finishedAt, leaseUntil: null } }
          );
          if (!completed.matchedCount) {
            leaseLost = true;
            campaign.status = 'interrupted';
            campaign.error = 'Campaign ownership expired before completion was saved; review recipient outcomes before retrying.';
            campaign.finishedAt = new Date().toISOString();
          }
        } catch (error) {
          console.error('Could not persist cold email campaign completion:', error.message);
          leaseLost = true;
          campaign.status = 'interrupted';
          campaign.error = 'Campaign completion could not be confirmed; review recipient outcomes before retrying.';
          campaign.finishedAt = new Date().toISOString();
        }
      }
      if (leaseLost && !campaign.finishedAt) campaign.finishedAt = new Date().toISOString();
      if (activeCampaigns.get(ownerKey) === id) activeCampaigns.delete(ownerKey);
    }
  })();

  return { id, total: campaign.total, status: campaign.status };
}

function cleanup() {
  const expiry = Date.now() - 60 * 60 * 1000;
  for (const [id, campaign] of campaigns) if (campaign.finishedAt && Date.parse(campaign.finishedAt) < expiry) campaigns.delete(id);
}

module.exports = { extractContacts, listContacts, importContacts, updateContact, deleteContact, startCampaign, status, recoverStaleCampaigns, cleanup, MAX_RECIPIENTS };
