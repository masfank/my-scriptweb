'use strict';

const express = require('express');
const { verifyLimiter, reportLimiter } = require('../middleware/rateLimit');
const { verify, listScripts } = require('../controllers/verifyController');
const { report } = require('../controllers/reportController');

const router = express.Router();

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Buyer-Token, X-App-Secret, User-Agent');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

router.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

router.get('/api/scripts', verifyLimiter, listScripts);
router.get('/api/verify', verifyLimiter, verify);
router.get('/api/report', reportLimiter, report);

module.exports = router;
