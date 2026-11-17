const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertTestDatabaseUri } = require('../scripts/testDatabaseGuard.cjs');

test('test database guard requires an explicit test URI', () => {
  assert.throws(() => assertTestDatabaseUri(undefined), /MONGODB_TEST_URI is required/);
});

test('test database guard rejects malformed, non-MongoDB, and production database URIs', () => {
  assert.throws(() => assertTestDatabaseUri('not a uri'), /valid MongoDB connection URI/);
  assert.throws(() => assertTestDatabaseUri('https://db.example.com/app_test'), /mongodb:\/\//);
  assert.throws(() => assertTestDatabaseUri('mongodb://localhost:27017/app'), /clearly contain "test"/);
});

test('test database guard accepts explicit test database names', () => {
  assert.equal(assertTestDatabaseUri('mongodb://127.0.0.1:27017/app_test'), 'app_test');
  assert.equal(assertTestDatabaseUri('mongodb+srv://user:secret@cluster.example.net/naukri-test?retryWrites=true'), 'naukri-test');
  assert.equal(assertTestDatabaseUri('mongodb://localhost:27017/test'), 'test');
});

test('test database guard rejects absent or malformed database names', () => {
  assert.throws(() => assertTestDatabaseUri('mongodb://localhost:27017/'), /dedicated test database/);
  assert.throws(() => assertTestDatabaseUri('mongodb://localhost:27017/app%2Fprod'), /dedicated test database/);
});
