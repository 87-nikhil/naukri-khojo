require('dotenv').config();
const mongoose = require('mongoose');
// Keep --check strictly read-only; --apply below explicitly builds indexes.
mongoose.set('autoIndex', false);
const { isDeepStrictEqual } = require('node:util');
const { getMongoOptions } = require('../src/mongoOptions');
const models = require('../src/models');

function indexIsPresent(expected, actual) {
  const [keys, options] = expected;
  return actual.some(index => isDeepStrictEqual(index.key, keys) &&
    (!options.unique || index.unique === true) &&
    (options.expireAfterSeconds === undefined || index.expireAfterSeconds === options.expireAfterSeconds) &&
    (options.partialFilterExpression === undefined || isDeepStrictEqual(index.partialFilterExpression, options.partialFilterExpression)));
}

async function inspectIndexes(modelList) {
  const collectionNames = new Set((await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name));
  const missing = [];
  const conflicts = [];
  for (const model of modelList) {
    const collectionExists = collectionNames.has(model.collection.collectionName);
    const actual = collectionExists ? await model.collection.indexes() : [];
    for (const expected of model.schema.indexes()) {
      if (indexIsPresent(expected, actual)) continue;
      const item = { model: model.modelName, keys: expected[0], options: expected[1] };
      missing.push(item);
      if (expected[1].unique && collectionExists) {
        const groupKeys = Object.fromEntries(Object.keys(expected[0]).map(key => [key, `$${key}`]));
        const pipeline = [
          ...(expected[1].partialFilterExpression ? [{ $match: expected[1].partialFilterExpression }] : []),
          { $group: { _id: groupKeys, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 1 },
        ];
        const duplicate = await model.collection.aggregate(pipeline).toArray();
        if (duplicate.length) conflicts.push({ model: model.modelName, keys: expected[0] });
      }
    }
  }
  return { missing, conflicts };
}

async function main() {
  const mode = process.argv[2];
  if (!['--check', '--apply'].includes(mode)) {
    throw new Error('Usage: node scripts/prepare-multi-user-db.cjs --check|--apply');
  }
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI before checking or preparing the multi-user database.');

  await mongoose.connect(process.env.MONGODB_URI, getMongoOptions());
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('Multi-user queue mode requires a MongoDB replica set or sharded cluster for transactions.');
    }

    const modelList = Object.values(models);
    if (mode === '--apply') {
      for (const model of modelList) await model.createIndexes();
    }
    const { missing, conflicts } = await inspectIndexes(modelList);
    if (missing.length) {
      console.error(`${missing.length} expected index(es) are missing:`);
      for (const index of missing) console.error(`- ${index.model} ${JSON.stringify(index.keys)} ${JSON.stringify(index.options)}`);
      if (conflicts.length) {
        console.error(`${conflicts.length} missing unique index(es) have duplicate keys:`);
        for (const index of conflicts) console.error(`- ${index.model} ${JSON.stringify(index.keys)}`);
      } else {
        console.log('No duplicate keys were found for the missing unique indexes in existing collections.');
      }
      if (mode === '--check') console.error('Run npm run automation:prepare-db after reviewing any duplicate-data/index conflicts.');
      process.exitCode = 1;
      return;
    }
    console.log(`All declared indexes are present for ${modelList.length} MongoDB models${mode === '--apply' ? ' (created or verified)' : ''}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async error => {
  console.error('Multi-user database preparation failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
