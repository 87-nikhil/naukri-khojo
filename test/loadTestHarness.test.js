const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

test('read-only API load harness exercises configured concurrency stages', async () => {
  let requests = 0;
  let invalidRequest = false;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.method !== 'GET' || !req.url.startsWith('/api/') || !req.headers.authorization?.startsWith('Bearer ')) invalidRequest = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-khojo-load-harness-'));
  const tokenFile = path.join(folder, 'users.json');
  const runId = '0123456789ab';
  const users = [1, 2, 3].map(index => {
    const userId = `64b00000000000000000000${index}`;
    const payload = Buffer.from(JSON.stringify({ userId })).toString('base64url');
    return { userId, email: `loadtest-${runId}-${String(index).padStart(3, '0')}@example.test`, token: `header.${payload}.signature` };
  });
  fs.writeFileSync(tokenFile, JSON.stringify({ runId, users }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { stdout } = await execFileAsync(process.execPath, [path.join(__dirname, '../scripts/load-test-api.cjs')], {
      env: {
        ...process.env,
        LOAD_TEST_BASE_URL: baseUrl,
        LOAD_TEST_TOKENS_FILE: tokenFile,
        LOAD_TEST_STAGES: '1,2',
        LOAD_TEST_ITERATIONS: '1',
        LOAD_TEST_TIMEOUT_MS: '2000',
      },
      timeout: 10_000,
    });
    assert.equal(requests, 15);
    assert.equal(invalidRequest, false);
    assert.match(stdout, /"concurrency":1/);
    assert.match(stdout, /"concurrency":2/);
    assert.match(stdout, /"requests":10/);
    assert.match(stdout, /"p95":/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('queue load harness sends one isolated enqueue per synthetic user', async () => {
  const userIds = new Set();
  let requests = 0;
  let invalidRequest = false;
  const server = http.createServer(async (req, res) => {
    requests++;
    const payload = JSON.parse(Buffer.from(req.headers.authorization?.split('.')[1] || '', 'base64url').toString('utf8') || '{}');
    userIds.add(payload.userId);
    const body = await new Promise(resolve => {
      let contents = '';
      req.on('data', chunk => { contents += chunk; });
      req.on('end', () => resolve(contents));
    });
    if (req.method !== 'POST' || req.url !== '/api/run' || body !== '{}' || !req.headers.authorization?.startsWith('Bearer ')) invalidRequest = true;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, runId: `run-${requests}` }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'naukri-khojo-queue-harness-'));
  const tokenFile = path.join(folder, 'users.json');
  const runId = 'abcdef012345';
  const users = [1, 2, 3].map(index => {
    const userId = `65b00000000000000000000${index}`;
    const payload = Buffer.from(JSON.stringify({ userId })).toString('base64url');
    return { userId, email: `loadtest-${runId}-${String(index).padStart(3, '0')}@example.test`, token: `header.${payload}.signature` };
  });
  fs.writeFileSync(tokenFile, JSON.stringify({ runId, users }));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { stdout } = await execFileAsync(process.execPath, [path.join(__dirname, '../scripts/load-test-queue.cjs')], {
      env: {
        ...process.env,
        LOAD_TEST_BASE_URL: baseUrl,
        LOAD_TEST_TOKENS_FILE: tokenFile,
        LOAD_TEST_STAGES: '1,2',
        LOAD_TEST_TIMEOUT_MS: '2000',
      },
      timeout: 10_000,
    });
    assert.equal(requests, 3);
    assert.equal(userIds.size, 3);
    assert.equal(invalidRequest, false);
    assert.match(stdout, /"concurrency":1/);
    assert.match(stdout, /"concurrency":2/);
    assert.match(stdout, /"accepted":2/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
