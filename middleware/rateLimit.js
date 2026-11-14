'use strict';

const rateLimit = require('express-rate-limit');

/* 20 verify / menit / IP. Buyer di belakang NAT berbagi kuota — lihat README. */
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).type('text/plain').send('ERROR:rate_limited');
  },
});

/* 10 percobaan login / 15 menit / IP. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).type('text/plain').send('Terlalu banyak percobaan login. Coba lagi nanti.');
  },
});

module.exports = { verifyLimiter, loginLimiter };
