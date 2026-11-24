'use strict';

const express = require('express');
const { verifyLimiter, reportLimiter } = require('../middleware/rateLimit');
const { verify, listScripts } = require('../controllers/verifyController');
const { report } = require('../controllers/reportController');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

router.get('/api/scripts', verifyLimiter, listScripts);
router.get('/api/verify', verifyLimiter, verify);
router.get('/api/report', reportLimiter, report);

module.exports = router;
