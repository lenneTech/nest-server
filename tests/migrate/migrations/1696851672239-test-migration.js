'use strict';

const { MongoClient } = require('mongodb');
const { callbackify } = require('util');
const { promisify } = require('util');

// MongoDB URL from test environment
const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1/nest-server-local';

module.exports.up = function (next) {
  callbackify(async () => {
    // Random sleep to simulate race conditions
    const sleepMs = Math.floor(Math.random() * 2000);
    await promisify(setTimeout)(sleepMs);

    let client;
    try {
      client = await MongoClient.connect(mongoUrl);
      await client.db().collection('test_migration_collection').insertOne({ migrated: true, timestamp: new Date() });
    } finally {
      await client?.close();
    }
  })(next);
};

module.exports.down = function (next) {
  callbackify(async () => {
    let client;
    try {
      client = await MongoClient.connect(mongoUrl);
      await client.db().collection('test_migration_collection').deleteMany({ migrated: true });
    } finally {
      await client?.close();
    }
  })(next);
};
