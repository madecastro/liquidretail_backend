'use strict';
// api role — HTTP surface. Phase 0 has /health only. Phase 1 adds
// inspect endpoints so operators can see queue depth + in-flight
// claims without hitting Mongo directly.

const express = require('express');
const mongoose = require('mongoose');

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => {
    const mongoReady = mongoose.connection.readyState === 1;
    res.status(mongoReady ? 200 : 503).json({
      ok:    mongoReady,
      role:  'api',
      mongo: mongoReady ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  });

  return app;
}

module.exports = { buildApp };
