function assertTestDatabaseUri(uri) {
  if (!uri) throw new Error('MONGODB_TEST_URI is required; test tooling never falls back to MONGODB_URI.');
  let parsed;
  try { parsed = new URL(uri); }
  catch { throw new Error('MONGODB_TEST_URI must be a valid MongoDB connection URI.'); }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('MONGODB_TEST_URI must use mongodb:// or mongodb+srv:// with a host.');
  }
  let databaseName;
  try { databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')); }
  catch { throw new Error('MONGODB_TEST_URI contains an invalid database name.'); }
  if (!databaseName || databaseName.includes('/')) throw new Error('MONGODB_TEST_URI must name a dedicated test database.');
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) throw new Error('Refusing database access: the MONGODB_TEST_URI database name must clearly contain "test".');
  return databaseName;
}

module.exports = { assertTestDatabaseUri };
