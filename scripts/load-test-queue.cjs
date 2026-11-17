require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

function numberSetting(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function readUsers(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-f\d]{12}$/i.test(data.runId || '') || !Array.isArray(data.users) || !data.users.length) throw new Error('Token file is not a valid synthetic load-test account file.');
  const ids = new Set();
  for (const user of data.users) {
    if (!/^[a-f\d]{24}$/i.test(user.userId || '') || typeof user.token !== 'string' || user.email !== `loadtest-${data.runId}-${String(data.users.indexOf(user) + 1).padStart(3, '0')}@example.test`) throw new Error('Token file contains an invalid or non-synthetic user entry.');
    if (ids.has(user.userId)) throw new Error('Token file contains duplicate user IDs.');
    ids.add(user.userId);
    let payload;
    try { payload = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new Error('Token file contains a malformed JWT.'); }
    if (String(payload.userId) !== user.userId) throw new Error('Token subject does not match its synthetic user ID.');
  }
  return data.users;
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] : 0;
}

async function enqueue(baseUrl, user, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const start = performance.now();
  try {
    const response = await fetch(new URL('/api/run', baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const accepted = response.status === 202 && body.success === true && typeof body.runId === 'string';
    return { status: response.status, accepted, durationMs: performance.now() - start, error: accepted ? null : `HTTP ${response.status}: ${body.error || body.message || 'queue request was not accepted'}` };
  } catch (error) {
    return { status: 0, accepted: false, durationMs: performance.now() - start, error: error.name === 'AbortError' ? 'request timed out' : error.message };
  } finally { clearTimeout(timer); }
}

async function main() {
  if (!process.env.LOAD_TEST_BASE_URL) throw new Error('Set LOAD_TEST_BASE_URL to the isolated queue API origin.');
  let baseUrl;
  try { baseUrl = new URL(process.env.LOAD_TEST_BASE_URL); }
  catch { throw new Error('LOAD_TEST_BASE_URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('Set LOAD_TEST_BASE_URL to the API origin, without credentials, query, or hash.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname) && process.env.LOAD_TEST_ALLOW_REMOTE !== 'true') {
    throw new Error('Remote queue load tests require LOAD_TEST_ALLOW_REMOTE=true and an isolated staging deployment.');
  }
  const tokenFile = path.resolve(process.env.LOAD_TEST_TOKENS_FILE || '');
  if (!process.env.LOAD_TEST_TOKENS_FILE || !fs.existsSync(tokenFile)) throw new Error('Set LOAD_TEST_TOKENS_FILE to the synthetic user token file created by automation:load-seed.');
  const users = readUsers(tokenFile);
  const stages = (process.env.LOAD_TEST_STAGES || '1,10,25,50,100').split(',').map(value => Number(value.trim()));
  if (!stages.length || stages.some((value, index) => !Number.isInteger(value) || value < 1 || value > 500 || (index && value <= stages[index - 1]))) {
    throw new Error('LOAD_TEST_STAGES must be increasing positive integers no greater than 500.');
  }
  const neededUsers = stages.reduce((total, value) => total + value, 0);
  if (users.length < neededUsers) throw new Error(`Queue stages need ${neededUsers} distinct users; the token file contains ${users.length}. Seed with LOAD_TEST_USERS=${neededUsers}.`);
  const timeoutMs = numberSetting('LOAD_TEST_TIMEOUT_MS', 20_000, 1000, 120_000);
  let userOffset = 0;
  console.log(`Queue-only load test against ${baseUrl.origin}; ${neededUsers} distinct synthetic accounts.`);
  console.log('Each request enqueues one job hunt. Do not run any automation worker during this test.');
  for (const concurrency of stages) {
    const current = users.slice(userOffset, userOffset + concurrency);
    userOffset += concurrency;
    const startedAt = performance.now();
    const results = await Promise.all(current.map(user => enqueue(baseUrl, user, timeoutMs)));
    const elapsedMs = performance.now() - startedAt;
    const durations = results.map(result => result.durationMs).sort((a, b) => a - b);
    const failures = results.filter(result => !result.accepted);
    const summary = {
      concurrency,
      accepted: results.length - failures.length,
      errors: failures.length,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
      enqueuesPerSecond: Number((results.length / (elapsedMs / 1000)).toFixed(2)),
      latencyMs: { p50: Number(percentile(durations, 0.50).toFixed(1)), p95: Number(percentile(durations, 0.95).toFixed(1)), p99: Number(percentile(durations, 0.99).toFixed(1)) },
      sampleErrors: failures.slice(0, 5).map(({ status, error }) => ({ status, error })),
    };
    console.log(JSON.stringify(summary));
    if (failures.length) process.exitCode = 1;
  }
}

main().catch(error => { console.error('Queue load test failed:', error.message); process.exitCode = 1; });
