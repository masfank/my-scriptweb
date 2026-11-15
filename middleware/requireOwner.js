'use strict';

module.exports = function requireOwner(req, res, next) {
  if (req.admin && req.admin.role === 'admin') {
    return next();
  }
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return res.status(403).render('error', {
    title: '403',
    status: 403,
    message: 'Halaman ini khusus Admin utama. Akun Leader hanya dapat mengelola Whitelist, Token Buyer, dan Log.',
  });
};
