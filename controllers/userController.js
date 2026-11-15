'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const PASS_MIN = 6;

function displayTime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function back(res, key, message) {
  return res.redirect(`/admin/users?${key}=` + encodeURIComponent(message));
}

exports.list = asyncHandler(async (req, res) => {
  const data = await store.read();
  const rows = Object.entries(data.admins)
    .map(([username, info]) => ({
      username,
      role: info.role || 'admin',
      created_at_display: displayTime(info.created_at),
      isSelf: req.admin && req.admin.username === username,
    }))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.username.localeCompare(b.username);
    });

  res.render('users', {
    title: 'Kelola Tim',
    admin: req.admin,
    rows,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.create = asyncHandler(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = req.body.role === 'admin' ? 'admin' : 'leader';

  if (!USERNAME_RE.test(username)) {
    return back(res, 'err', 'Username harus 3–32 karakter (huruf, angka, _, ., -)');
  }
  if (password.length < PASS_MIN) {
    return back(res, 'err', `Password minimal ${PASS_MIN} karakter`);
  }

  const data = await store.read();
  if (data.admins[username]) {
    return back(res, 'err', `Username '${username}' sudah terdaftar`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const apiToken = crypto.randomBytes(32).toString('hex');

  await store.update((db) => {
    if (db.admins[username]) throw new store.StoreError(`Username '${username}' sudah terdaftar`);
    db.admins[username] = {
      password_hash: passwordHash,
      api_token: apiToken,
      role,
      created_at: new Date().toISOString(),
    };
  });

  return back(res, 'ok', `Akun '${username}' (${role}) berhasil dibuat.`);
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const username = req.params.username;
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!USERNAME_RE.test(username)) return back(res, 'err', 'Username tidak valid');
  if (password.length < PASS_MIN) {
    return back(res, 'err', `Password baru minimal ${PASS_MIN} karakter`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await store.update((db) => {
      if (!db.admins[username]) throw new store.StoreError('not_found');
      db.admins[username].password_hash = passwordHash;
    });
  } catch (err) {
    if (err.message === 'not_found') return back(res, 'err', `Akun '${username}' tidak ditemukan`);
    throw err;
  }

  return back(res, 'ok', `Password '${username}' diperbarui.`);
});

exports.remove = asyncHandler(async (req, res) => {
  const username = req.params.username;
  if (!USERNAME_RE.test(username)) return back(res, 'err', 'Username tidak valid');
  if (req.admin && req.admin.username === username) {
    return back(res, 'err', 'Tidak bisa menghapus akun yang sedang dipakai login');
  }

  try {
    await store.update((db) => {
      if (!db.admins[username]) throw new store.StoreError('not_found');
      delete db.admins[username];
    });
  } catch (err) {
    if (err.message === 'not_found') return back(res, 'err', `Akun '${username}' tidak ditemukan`);
    throw err;
  }

  return back(res, 'ok', `Akun '${username}' dihapus.`);
});
