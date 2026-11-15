'use strict';

/**
 * requireAdmin — lolos kalau:
 *   Authorization: Bearer <api_token> milik salah satu admin, atau
 *   session cookie berisi { admin: { username } }.
 * Gagal: 401 JSON untuk request JSON, redirect /login?next=… untuk HTML.
 */

const store = require('../db/store');
const safeEqual = require('./safeEqual');

const BEARER_RE = /^Bearer (.+)$/;

module.exports = async function requireAdmin(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = header.match(BEARER_RE);

    if (match) {
      const token = match[1].trim();
      const data = await store.read();
      for (const [username, admin] of Object.entries(data.admins)) {
        if (safeEqual(token, admin.api_token)) {
          req.admin = { username, role: admin.role || 'admin' };
          req.adminViaBearer = true;
          return next();
        }
      }
    }

    if (req.session && req.session.admin && req.session.admin.username) {
      const data = await store.read();
      const liveAdmin = data.admins[req.session.admin.username];
      if (!liveAdmin) {
        req.session = null;
      } else {
        req.admin = { username: req.session.admin.username, role: liveAdmin.role || 'admin' };
        return next();
      }
    }

    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${nextUrl}`);
  } catch (err) {
    return next(err);
  }
};
