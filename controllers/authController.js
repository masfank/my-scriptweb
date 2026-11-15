'use strict';

const bcrypt = require('bcryptjs');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

/* hash dummy: percobaan username tak dikenal tetap membayar biaya bcrypt */
const DUMMY_HASH = bcrypt.hashSync('timing-placeholder-tidak-dipakai', 12);

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const SETUP_PASS_MIN = 6;

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/admin') ? value : '/admin';
}

exports.showSetup = asyncHandler(async (req, res) => {
  const data = await store.read();
  if (Object.keys(data.admins).length > 0) {
    return res.redirect(req.session && req.session.admin ? '/admin' : '/login');
  }
  return res.render('setup', {
    title: 'Setup Admin',
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.setup = asyncHandler(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const back = (msg) => res.redirect('/setup?err=' + encodeURIComponent(msg));

  if (!USERNAME_RE.test(username)) {
    return back('Username harus 3–32 karakter (huruf, angka, _, ., -)');
  }
  if (password.length < SETUP_PASS_MIN) {
    return back(`Password minimal ${SETUP_PASS_MIN} karakter`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const apiToken = require('crypto').randomBytes(32).toString('hex');

  try {
    await store.update((db) => {
      if (Object.keys(db.admins).length > 0) {
        throw new store.StoreError('already_setup');
      }
      db.admins[username] = {
        password_hash: passwordHash,
        api_token: apiToken,
        role: 'admin',
        created_at: new Date().toISOString(),
      };
    });
  } catch (err) {
    if (err.message === 'already_setup') {
      return res.redirect('/login');
    }
    throw err;
  }

  req.session.admin = { username };
  return res.redirect('/admin?ok=' + encodeURIComponent(`Admin '${username}' berhasil dibuat.`));
});

exports.showLogin = asyncHandler(async (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/admin');
  const data = await store.read();
  if (Object.keys(data.admins).length === 0) return res.redirect('/setup');
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
