require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const endpoints = ['/api/resume', '/api/jobs?limit=20', '/api/applications', '/api/automation/runs', '/api/analytics'];

function numberSetting(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function loadUsers(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-f\d]{12}$/i.test(data.runId || '') || !Array.isArray(data.users) || !data.users.length) throw new Error('Token file is not a valid synthetic load-test account file.');
  const seen = new Set();
  for (const user of data.users) {
    if (!/^[a-f\d]{24}$/i.test(user.userId || '') || typeof user.token !== 'string' || !user.email?.startsWith(`loadtest-${data.runId}-`)) throw new Error('Token file contains an invalid or non-synthetic user entry.');
    if (seen.has(user.userId)) throw new Error('Token file contains duplicate user IDs.');
    seen.add(user.userId);
    let payload;
    try { payload = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new Error('Token file contains a malformed JWT.'); }
    if (String(payload.userId) !== user.userId) throw new Error('Token subject does not match its synthetic user ID.');
  }
  return data.users;
}

async function request(baseUrl, token, endpoint, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const start = performance.now();
  try {
    const response = await fetch(new URL(endpoint, baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    await response.arrayBuffer();
    return { endpoint, status: response.status, durationMs: performance.now() - start, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { endpoint, status: 0, durationMs: performance.now() - start, error: error.name === 'AbortError' ? 'request timed out' : error.message };
  } finally { clearTimeout(timer); }
}

async function runStage(baseUrl, users, concurrency, iterations, timeoutMs) {
  const samples = [];
  let nextUser = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextUser++;
      if (index >= concurrency) return;
      const user = users[index];
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (const endpoint of endpoints) samples.push(await request(baseUrl, user.token, endpoint, timeoutMs));
      }
    }
  });
  const startedAt = performance.now();
  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;
  const durations = samples.map(sample => sample.durationMs).sort((a, b) => a - b);
  const failures = samples.filter(sample => sample.error);
  const byEndpoint = Object.fromEntries(endpoints.map(endpoint => {
    const subset = samples.filter(sample => sample.endpoint === endpoint);
    return [endpoint, { requests: subset.length, errors: subset.filter(sample => sample.error).length }];
  }));
  return {
    concurrency,
    requests: samples.length,
    errors: failures.length,
    elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
    requestsPerSecond: Number((samples.length / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: { p50: Number(percentile(durations, 0.50).toFixed(1)), p95: Number(percentile(durations, 0.95).toFixed(1)), p99: Number(percentile(durations, 0.99).toFixed(1)) },
    byEndpoint,
    sampleErrors: failures.slice(0, 5).map(({ endpoint, status, error }) => ({ endpoint, status, error })),
  };
}

async function main() {
  if (!process.env.LOAD_TEST_BASE_URL) throw new Error('Set LOAD_TEST_BASE_URL to the isolated API origin.');
  let baseUrl;
  try { baseUrl = new URL(process.env.LOAD_TEST_BASE_URL); }
  catch { throw new Error('LOAD_TEST_BASE_URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('Set LOAD_TEST_BASE_URL to the API origin, without credentials, query, or hash.');
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
  if (!isLocal && process.env.LOAD_TEST_ALLOW_REMOTE !== 'true') throw new Error('Remote load tests require LOAD_TEST_ALLOW_REMOTE=true and must target an isolated staging deployment.');
  const tokenFile = path.resolve(process.env.LOAD_TEST_TOKENS_FILE || '');
  if (!process.env.LOAD_TEST_TOKENS_FILE || !fs.existsSync(tokenFile)) throw new Error('Set LOAD_TEST_TOKENS_FILE to the synthetic user token file created by automation:load-seed.');
  const users = loadUsers(tokenFile);
  const rawStages = (process.env.LOAD_TEST_STAGES || '1,10,25,50,100').split(',').map(value => Number(value.trim()));
  if (!rawStages.length || rawStages.some(value => !Number.isInteger(value) || value < 1 || value > users.length) || rawStages.some((value, i) => i && value <= rawStages[i - 1])) {
    throw new Error(`LOAD_TEST_STAGES must be increasing integers from 1 to the ${users.length} available synthetic users.`);
  }
  const iterations = numberSetting('LOAD_TEST_ITERATIONS', 3, 1, 100);
  const timeoutMs = numberSetting('LOAD_TEST_TIMEOUT_MS', 20_000, 1000, 120_000);
  console.log(`Read-only dashboard API load test against ${baseUrl.origin}; ${users.length} synthetic accounts, ${iterations} cycles per account.`);
  console.log(`Endpoints: ${endpoints.join(', ')}`);
  for (const concurrency of rawStages) {
    const result = await runStage(baseUrl, users, concurrency, iterations, timeoutMs);
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 1;
  }
}

main().catch(error => { console.error('API load test failed:', error.message); process.exitCode = 1; });
