'use strict';

const express = require('express');
const { verifyLimiter } = require('../middleware/rateLimit');
const { verify } = require('../controllers/verifyController');

const router = express.Router();

router.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

router.get('/api/verify', verifyLimiter, verify);

module.exports = router;
