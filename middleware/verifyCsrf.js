'use strict';

const safeEqual = require('./safeEqual');

module.exports = function verifyCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  /* request API otomatis memakai Authorization: Bearer, bukan cookie session */
  if (req.adminViaBearer === true) {
    return next();
  }

  const expected = req.session && typeof req.session.csrfToken === 'string' ? req.session.csrfToken : '';
  const provided =
    (typeof req.get('x-csrf-token') === 'string' && req.get('x-csrf-token').trim()) ||
    (req.body && typeof req.body._csrf === 'string' ? req.body._csrf.trim() : '');

  if (!expected || !provided || !safeEqual(provided, expected)) {
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(403).json({ ok: false, error: 'csrf_invalid' });
    }
    return res.status(403).render('error', {
      title: '403',
      status: 403,
      message: 'Token keamanan formulir (CSRF) tidak valid atau kedaluwarsa. Muat ulang halaman lalu coba lagi.',
    });
  }

  return next();
};
