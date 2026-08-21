'use strict';
// Mongo connection. Shared cluster with backend — bounded by service
// role, not by schema. Every model we define here targets the same
// collection backend writes to; strict:false on the schemas lets us
// read the full doc without needing to duplicate every field.

const mongoose = require('mongoose');
const { MONGODB_URI } = require('./config');

async function connect() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });
  console.log(`✓ mongo connected: ${mongoose.connection.db.databaseName}`);
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

module.exports = { connect, disconnect };
