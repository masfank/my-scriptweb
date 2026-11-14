'use strict';

const bcrypt = require('bcryptjs');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

/* hash dummy: percobaan username tak dikenal tetap membayar biaya bcrypt */
const DUMMY_HASH = bcrypt.hashSync('timing-placeholder-tidak-dipakai', 12);

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/admin') ? value : '/admin';
}

exports.showLogin = asyncHandler(async (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin');
  const next = typeof req.query.next === 'string' ? req.query.next : '';
  res.render('login', {
    title: 'Login',
    err: typeof req.query.err === 'string' ? req.query.err : null,
    next,
  });
});

exports.login = asyncHandler(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const nextUrl = safeNext(req.body.next);

  const data = await store.read();
  const admin = data.admins[username];

  const ok = admin
    ? await bcrypt.compare(password, admin.password_hash)
    : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

  if (!ok) {
    let target = '/login?err=' + encodeURIComponent('Username atau password salah');
    if (nextUrl !== '/admin') target += '&next=' + encodeURIComponent(nextUrl);
    return res.redirect(target);
  }

  req.session.admin = { username };
  return res.redirect(nextUrl);
});

exports.logout = (req, res) => {
  req.session = null;
  res.redirect('/login');
};
