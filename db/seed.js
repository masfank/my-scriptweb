'use strict';

/**
 * db/seed.js — buat / timpa admin pertama.
 *   node db/seed.js <username> <password> [--force]
 * APP_SECRET (kalau di-set) ikut di-seed ke settings.app_secret saat masih kosong.
 */

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function usage() {
  console.error('pemakaian: node db/seed.js <username> <password> [--force]');
  console.error("contoh   : node db/seed.js admin 'PasswordKuat123'");
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => a !== '--force');
  const [username, password] = positional;

  if (!username || !password) {
    usage();
    process.exit(1);
  }
  if (!USERNAME_RE.test(username)) {
    console.error('username harus 3-32 karakter: huruf, angka, titik, garis bawah, strip.');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('password minimal 10 karakter.');
    process.exit(1);
  }

  await store.ensureDataDir();

  const passwordHash = await bcrypt.hash(password, 12);
  const apiToken = crypto.randomBytes(32).toString('hex');

  try {
    await store.update((data) => {
      if (data.admins[username] && !force) {
        throw new store.StoreError(
          `admin '${username}' sudah ada, pakai --force untuk menimpa`
        );
      }
      data.admins[username] = {
        password_hash: passwordHash,
        api_token: apiToken,
        created_at: new Date().toISOString(),
      };
      if (process.env.APP_SECRET && !data.settings.app_secret) {
        data.settings.app_secret = process.env.APP_SECRET;
      }
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log('admin dibuat:', username);
  console.log('api_token:', apiToken);
  if (process.env.APP_SECRET) {
    console.log('app_secret di-seed dari APP_SECRET.');
  } else {
    console.log('catatan: settings.app_secret masih kosong — isi APP_SECRET di .env sebelum start.');
    console.log('         Panel /admin/secret baru bisa dibuka setelah server punya secret.');
  }
}

main().catch((err) => {
  console.error('seed gagal:', err.message);
  process.exit(1);
});
